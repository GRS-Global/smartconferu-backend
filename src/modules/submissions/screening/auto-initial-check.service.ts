import { Injectable, Logger } from '@nestjs/common';
import type { Executor, Tx } from '../../../core/database/database.types.js';
import { PlanService } from '../../../core/plan/plan.service.js';
import { ScreeningNoticeService } from '../screening-notice.service.js';
import {
  type FileRow,
  type SubmissionRow,
  SubmissionsRepository,
} from '../submissions.repository.js';
import type { AutoCheck } from './auto-check.js';
import {
  evaluateCheck,
  type ScreeningConfig,
  screeningConfigOf,
  withoutBlindMissing,
} from './screening-rules.js';

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * AI mode (Conference Settings › Screening › Auto initial check). The app reads each paper version
 * in the browser when it is uploaded (rules, then Claude when unsure) and sends the result with the
 * file; the API stores it on that version and, with AI mode on, decides the initial check from it:
 *
 * - only a certain result is decided: every requirement met → Passed; otherwise, per the setting,
 *   Revision with the list of problems (the authors are emailed) or left for the chair;
 * - an unsure result, a file the app couldn't read (a Word file…) or no result at all is left for
 *   the chair;
 * - a decision already made — by the chair, or earlier — is never touched, and only the newest
 *   version is decided. The chair can change any automatic decision.
 *
 * With AI mode off the result is still kept (the chair's table shows it as a suggestion), but
 * nothing is decided: the chair checks every paper by hand.
 */
@Injectable()
export class AutoInitialCheckService {
  private readonly logger = new Logger(AutoInitialCheckService.name);

  constructor(
    private readonly submissions: SubmissionsRepository,
    private readonly plan: PlanService,
    private readonly notices: ScreeningNoticeService,
  ) {}

  /** AI mode is on for the conference (and part of its plan). */
  async aiModeOn(
    executor: Executor,
    conferenceId: string,
    config?: ScreeningConfig,
  ): Promise<boolean> {
    const { settings } =
      config ??
      screeningConfigOf(
        await this.submissions.conferenceSettings(executor, conferenceId),
      );
    return (
      settings.initialCheck &&
      settings.autoInitialCheck &&
      (await this.plan.hasFeature(executor, conferenceId, 'autoInitialCheck'))
    );
  }

  /**
   * Keeps the app's result on the version and, with AI mode on, decides it. Runs in the caller's
   * transaction, with the paper locked. Returns the result as stored.
   */
  async apply(
    tx: Tx,
    submission: SubmissionRow,
    file: FileRow,
    auto: AutoCheck,
  ): Promise<AutoCheck> {
    const info = (await this.submissions.conferenceInfo(
      tx,
      submission.conferenceId,
    ))!;
    // Under double-blind review the PDF must not carry author names or affiliations.
    const result: AutoCheck = auto.missing
      ? {
          ...auto,
          missing: withoutBlindMissing(
            auto.missing,
            info.reviewMode === 'double_blind',
          ),
        }
      : { ...auto };
    const decision = await this.decide(tx, submission, file, result);
    const stored = decision ? { ...result, decision } : result;
    await this.submissions.saveAutoCheck(tx, file.id, { ...stored });
    return stored;
  }

  /**
   * AI mode was just turned on: decide every paper whose newest version has a result from the app
   * and no initial check decision yet.
   */
  async decideWaiting(tx: Tx, conferenceId: string): Promise<void> {
    for (const fileId of await this.submissions.checkedVersionsWaiting(
      tx,
      conferenceId,
    )) {
      const file = (await this.submissions.fileById(tx, fileId))!;
      const submission = (await this.submissions.findForUpdate(
        tx,
        file.submissionId,
      ))!;
      const auto = file.autoCheck as AutoCheck;
      const decision = await this.decide(tx, submission, file, auto);
      if (decision) {
        await this.submissions.saveAutoCheck(tx, file.id, {
          ...auto,
          decision,
        });
      }
    }
  }

  /** Decides the version from a certain result. Returns what AI mode did, or undefined when it's off. */
  private async decide(
    tx: Tx,
    submission: SubmissionRow,
    file: FileRow,
    auto: AutoCheck,
  ): Promise<AutoCheck['decision']> {
    if (submission.status !== 'submitted' || file.kind === 'supplementary') {
      return undefined;
    }
    if (
      file.version !==
      (await this.submissions.paperVersionCount(tx, submission.id))
    ) {
      return undefined; // a newer version arrived
    }
    const config = screeningConfigOf(
      await this.submissions.conferenceSettings(tx, submission.conferenceId),
    );
    if (!(await this.aiModeOn(tx, submission.conferenceId, config))) {
      return undefined;
    }

    const at = new Date().toISOString();
    const key = String(file.version);
    const screening = {
      ...(submission.screening as Record<string, Record<string, unknown>>),
    };
    const record = { ...(screening[key] ?? {}) };
    const check = (record.check ?? {}) as Record<string, unknown>;

    if ((check.decision ?? 'pending') !== 'pending' || check.chairSet) {
      return { outcome: 'already_decided', at };
    }
    if (auto.status !== 'done') {
      return { outcome: 'left_for_chair', reason: auto.error, at };
    }
    const certain =
      auto.editable === false ||
      (typeof auto.english === 'boolean' &&
        (auto.column === 'single' || auto.column === 'double') &&
        auto.confidence?.english === 'high' &&
        auto.confidence?.column === 'high');
    if (!certain) {
      return {
        outcome: 'left_for_chair',
        reason: auto.aiError
          ? `Not sure of the layout or language (${auto.aiError})`
          : 'Not sure of the layout or language',
        at,
      };
    }

    const { criteria, settings } = config;
    const values = {
      editable: auto.editable === true,
      english: auto.english ?? true,
      column:
        auto.column ?? (criteria.column === 'double' ? 'double' : 'single'),
      pages: auto.pages ?? null,
    } as const;
    const failing = evaluateCheck(values, criteria).filter((i) => !i.ok);
    const base = {
      ...check,
      editable: values.editable,
      english: values.english,
      column: values.column,
      pages: values.pages === null ? '' : String(values.pages),
      autoSet: true,
      at,
      by: 'Auto initial check',
    };

    if (failing.length === 0) {
      record.check = { ...base, decision: 'passed', passed: true };
      screening[key] = record;
      await this.submissions.update(tx, submission.id, { screening });
      return { outcome: 'passed', at };
    }
    if (settings.autoInitialFail !== 'send_back') {
      return {
        outcome: 'left_for_chair',
        reason: failing.map((f) => f.label).join(', '),
        at,
      };
    }

    const deadline = new Date();
    deadline.setUTCDate(deadline.getUTCDate() + criteria.correctionDays);
    const problems = failing.map((f) => f.problem);
    record.check = {
      ...base,
      decision: 'revision',
      passed: false,
      emailedAt: at,
    };
    record.correction = {
      reasons: problems,
      note: '',
      deadline: isoDay(deadline),
      at,
      by: 'Auto initial check',
      emailedAt: at,
    };
    screening[key] = record;
    const updated = await this.submissions.update(tx, submission.id, {
      screening,
    });
    await this.notices.send(
      tx,
      updated,
      file.version,
      { stage: 'correction', kind: 'main', coAuthors: false },
      null,
    );
    this.logger.log(
      { submissionId: submission.id, version: file.version },
      'Auto initial check sent the paper back',
    );
    return { outcome: 'sent_back', reason: problems.join(' '), at };
  }
}
