import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Executor, Tx } from '../../core/database/database.types.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import { PlanService } from '../../core/plan/plan.service.js';
import * as rules from '../../core/rbac/access-rules.js';
import { AccessService } from '../../core/rbac/access.service.js';
import type {
  EmailsQueuedResponse,
  RecordDecisionDto,
  ScreeningNoticeDto,
  SubmissionResponse,
} from './dto/submission.dto.js';
import type {
  ScreeningSettingsResponse,
  UpdateScreeningSettingsDto,
} from './dto/screening.dto.js';
import { ScreeningNoticeService } from './screening-notice.service.js';
import { AutoInitialCheckService } from './screening/auto-initial-check.service.js';
import { validateScreeningRecord } from './screening/screening-record.js';
import {
  type ScreeningConfig,
  screeningConfigOf,
} from './screening/screening-rules.js';
import { STAGE_OUTCOMES } from './submission.mapper.js';
import { SubmissionsRepository } from './submissions.repository.js';
import { SubmissionsService } from './submissions.service.js';

/**
 * The chair's side of a new paper: the screening record of each version (Initial Check and
 * Plagiarism Check), emailing the authors a screening decision, and recording a decision or a
 * stage (e.g. "Plagiarism clear", after which reviewers can be assigned).
 */
@Injectable()
export class ScreeningService {
  constructor(
    private readonly database: DatabaseService,
    private readonly submissions: SubmissionsRepository,
    private readonly papers: SubmissionsService,
    private readonly access: AccessService,
    private readonly notices: ScreeningNoticeService,
    private readonly autoCheck: AutoInitialCheckService,
    private readonly audit: AuditService,
    private readonly plan: PlanService,
  ) {}

  // Settings --------------------------------------------------------------------------------------

  /** The conference's screening steps, criteria and AI mode (chairs). */
  async getSettings(
    user: AuthUser,
    conferenceId: string,
  ): Promise<ScreeningSettingsResponse> {
    const db = this.database.db;
    const access = await this.access.requireConference(user, conferenceId, db);
    if (!rules.isChair(access)) {
      throw AppException.forbidden(
        'Only a chair of this conference can see its screening settings.',
      );
    }
    return this.settingsView(db, conferenceId);
  }

  /**
   * Saves the screening settings. Turning AI mode on decides, from their automatic check, the
   * papers whose newest version is still waiting for its initial check.
   */
  async updateSettings(
    user: AuthUser,
    conferenceId: string,
    dto: UpdateScreeningSettingsDto,
    client: ClientInfo,
  ): Promise<ScreeningSettingsResponse> {
    return this.database.transaction(async (tx) => {
      const access = await this.access.requireConference(
        user,
        conferenceId,
        tx,
      );
      if (!rules.isChair(access)) {
        throw AppException.forbidden(
          'Only a chair of this conference can change its screening settings.',
        );
      }
      const conference = (await this.submissions.conferenceSettings(
        tx,
        conferenceId,
      ))!;
      const before = screeningConfigOf(conference);
      const next: ScreeningConfig = {
        settings: { ...before.settings, ...definedOnly(dto.settings) },
        criteria: { ...before.criteria, ...definedOnly(dto.criteria) },
      };
      const c = next.criteria;
      if (c.minPages > c.maxPages || c.doubleMinPages > c.doubleMaxPages) {
        throw AppException.validation(
          'The minimum page count must not be above the maximum.',
        );
      }
      const entitled = await this.plan.hasFeature(
        tx,
        conferenceId,
        'autoInitialCheck',
      );
      if (
        next.settings.autoInitialCheck &&
        !before.settings.autoInitialCheck &&
        !entitled
      ) {
        throw AppException.forbidden(
          "AI mode isn't part of this conference's plan.",
        );
      }
      await this.submissions.saveScreeningConfig(tx, conferenceId, next);

      const switchedOn =
        next.settings.autoInitialCheck &&
        next.settings.initialCheck &&
        !(before.settings.autoInitialCheck && before.settings.initialCheck);
      if (switchedOn) {
        await this.autoCheck.decideWaiting(tx, conferenceId);
      }
      await this.audit.record(
        {
          action: 'conference.screening_settings_updated',
          actorId: user.id,
          entityType: 'conference',
          entityId: conferenceId,
          client,
          data: { settings: next.settings },
        },
        tx,
      );
      return this.settingsView(tx, conferenceId);
    });
  }

  private async settingsView(
    executor: Executor,
    conferenceId: string,
  ): Promise<ScreeningSettingsResponse> {
    const conference = await this.submissions.conferenceSettings(
      executor,
      conferenceId,
    );
    const config = screeningConfigOf(conference);
    const aiModeAvailable = await this.plan.hasFeature(
      executor,
      conferenceId,
      'autoInitialCheck',
    );
    return { ...config, aiModeAvailable };
  }

  // Records ---------------------------------------------------------------------------------------

  /**
   * Saves the chair's screening record of version `version` (replaces that version's record),
   * after checking it. A decision the chair sets is marked as theirs, so the automatic check never
   * overwrites it.
   */
  async saveRecord(
    user: AuthUser,
    submissionId: string,
    version: number,
    record: Record<string, unknown>,
  ): Promise<SubmissionResponse> {
    return this.database.transaction(async (tx) => {
      const { submission } = await this.requireChair(tx, user, submissionId);
      const versions = await this.submissions.paperVersionCount(
        tx,
        submissionId,
      );
      if (version > versions) {
        throw AppException.validation(
          versions === 0
            ? 'This paper has no file to screen yet.'
            : `This paper has ${versions} version${versions === 1 ? '' : 's'}; there is no version ${version}.`,
        );
      }
      const conference = await this.submissions.conferenceSettings(
        tx,
        submission.conferenceId,
      );
      // The automatic check belongs to the file, not to the chair's record.
      const { auto: _auto, ...own } = record;
      validateScreeningRecord(own, {
        folder: `${submission.conferenceId}/${submissionId}/`,
        initialCheck: screeningConfigOf(conference).settings.initialCheck,
      });

      const stored = (
        submission.screening as Record<
          string,
          Record<string, unknown> | undefined
        >
      )[String(version)];
      const storedCheck = (stored?.check ?? {}) as Record<string, unknown>;
      const check = own.check as Record<string, unknown> | undefined;
      if (
        check &&
        (check.decision ?? 'pending') !== (storedCheck.decision ?? 'pending')
      ) {
        // The chair decided: theirs from now on.
        delete check.autoSet;
        check.chairSet = true;
        check.decidedBy = user.id;
      } else if (check && storedCheck.autoSet) {
        // Unchanged automatic decision: keep its tag (the client may not echo it back).
        check.autoSet = true;
      }

      await this.submissions.update(tx, submissionId, {
        screening: {
          ...(submission.screening as Record<string, unknown>),
          [String(version)]: own,
        },
      });
      return this.papers.view(tx, user, submissionId);
    });
  }

  /**
   * Emails the authors the screening decision saved on version `version` and rings their bell.
   */
  async notify(
    user: AuthUser,
    submissionId: string,
    version: number,
    dto: ScreeningNoticeDto,
    client: ClientInfo,
  ): Promise<EmailsQueuedResponse> {
    return this.database.transaction(async (tx) => {
      const { submission } = await this.requireChair(tx, user, submissionId);
      const result = await this.notices.send(
        tx,
        submission,
        version,
        {
          stage: dto.stage,
          kind: dto.kind ?? 'main',
          coAuthors: dto.coAuthors ?? false,
        },
        user,
      );
      await this.audit.record(
        {
          action: 'submission.screening_notified',
          actorId: user.id,
          entityType: 'submission',
          entityId: submissionId,
          client,
          data: { version, stage: dto.stage, kind: dto.kind ?? 'main' },
        },
        tx,
      );
      return result;
    });
  }

  /**
   * Records a decision or a stage from the conference's decision types. Authors aren't told until
   * the chair sends the decision (the decisions module).
   */
  async recordDecision(
    user: AuthUser,
    submissionId: string,
    dto: RecordDecisionDto,
    client: ClientInfo,
  ): Promise<SubmissionResponse> {
    return this.database.transaction(async (tx) => {
      const { submission } = await this.requireChair(tx, user, submissionId);
      if (submission.status === 'withdrawn') {
        throw AppException.businessRule(
          'This paper has been withdrawn, so it takes no decision.',
        );
      }
      const type = await this.submissions.decisionType(
        tx,
        submission.conferenceId,
        dto.decisionTypeId,
      );
      if (!type) {
        throw AppException.validation(
          'Unknown decision type for this conference.',
        );
      }
      const isStage = STAGE_OUTCOMES.includes(type.outcome);
      await this.submissions.update(tx, submissionId, {
        outcome: type.outcome,
        decisionTypeId: type.id,
        decisionNote: dto.note ?? submission.decisionNote,
        deskRejected:
          type.outcome === 'reject' && Boolean(dto.deskRejectReason),
        deskRejectReason:
          type.outcome === 'reject' ? (dto.deskRejectReason ?? null) : null,
        decidedAt: isStage ? null : new Date(),
        decidedBy: user.id,
      });
      await this.submissions.insertDecisionEvent(tx, {
        submissionId,
        outcome: type.outcome,
        decisionTypeId: type.id,
        note: dto.note ?? null,
        decidedBy: user.id,
      });
      await this.audit.record(
        {
          action: 'submission.decision_recorded',
          actorId: user.id,
          entityType: 'submission',
          entityId: submissionId,
          client,
          data: { outcome: type.outcome, decisionTypeId: type.id },
        },
        tx,
      );
      return this.papers.view(tx, user, submissionId);
    });
  }

  private async requireChair(tx: Tx, user: AuthUser, submissionId: string) {
    const submission = await this.submissions.findForUpdate(tx, submissionId);
    if (!submission) {
      throw AppException.notFound('The paper');
    }
    const access = await this.access.requireSubmission(user, submissionId, tx);
    if (!rules.canDecide(access)) {
      throw AppException.forbidden(
        'Only a chair of this conference can screen papers and record decisions.',
      );
    }
    return { access, submission };
  }
}

/** The fields that were sent (a validated DTO also carries the ones left out, as undefined). */
function definedOnly<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
