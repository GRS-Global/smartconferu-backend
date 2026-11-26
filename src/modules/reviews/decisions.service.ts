import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import { EmailQueueService } from '../../core/email/email-queue.service.js';
import { EmailRecipientsService } from '../../core/email/email-recipients.service.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import { NotificationsService } from '../../core/notifications/notifications.service.js';
import * as rules from '../../core/rbac/access-rules.js';
import { AccessService } from '../../core/rbac/access.service.js';
import {
  ACCEPTED_OUTCOMES,
  paperId,
  STAGE_OUTCOMES,
} from '../submissions/submission.mapper.js';
import { SubmissionsRepository } from '../submissions/submissions.repository.js';
import { SubmissionsService } from '../submissions/submissions.service.js';
import type {
  DecisionSentResponse,
  DecisionTypeResponse,
  DecisionTypesDto,
  NotifyDecisionDto,
} from './dto/review.dto.js';
import { ReviewEmailsService } from './review-emails.service.js';
import { toDecisionType } from './review.mapper.js';
import { ReviewsRepository } from './reviews.repository.js';

const DEFAULT_COLOR = '#64748B';

/**
 * Sending a recorded decision to the authors, and the conference's list of decision types.
 * (Recording a decision is POST /submissions/:id/decision, in the submissions module.)
 *
 * Replaces: notify_decision, notify_submission_authors, the decision_notified emails, and the
 * app's direct writes to decision_types.
 */
@Injectable()
export class DecisionsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly reviews: ReviewsRepository,
    private readonly submissions: SubmissionsRepository,
    private readonly papers: SubmissionsService,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
    private readonly emails: EmailQueueService,
    private readonly recipients: EmailRecipientsService,
    private readonly reviewEmails: ReviewEmailsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Tells the authors the recorded decision: from now on it is what they see, they get it in their
   * bell and by email (with the reviews the chair shares), and everyone who reviewed the paper gets
   * the final decision. Sending a different decision than the one told before sends "Decision
   * changed".
   */
  async notify(
    user: AuthUser,
    submissionId: string,
    dto: NotifyDecisionDto,
    client: ClientInfo,
  ): Promise<DecisionSentResponse> {
    return this.database.transaction(async (tx) => {
      const submission = await this.submissions.findForUpdate(tx, submissionId);
      if (!submission) {
        throw AppException.notFound('The paper');
      }
      const access = await this.access.requireSubmission(
        user,
        submissionId,
        tx,
      );
      if (!rules.canDecide(access)) {
        throw AppException.forbidden(
          'Only a chair of this conference can send decisions to the authors.',
        );
      }
      if (submission.status === 'withdrawn') {
        throw AppException.businessRule('This paper has been withdrawn.');
      }
      if (STAGE_OUTCOMES.includes(submission.outcome)) {
        throw AppException.businessRule(
          'Record a decision before notifying the authors.',
        );
      }
      const info = (await this.submissions.conferenceInfo(
        tx,
        submission.conferenceId,
      ))!;
      // The acceptance email tells the authors where to register and pay.
      if (
        ACCEPTED_OUTCOMES.includes(submission.outcome) &&
        !info.registrationUrl
      ) {
        throw AppException.businessRule(
          'Add the registration link in the conference details before sending acceptances: the authors need it to register and pay.',
        );
      }

      const changed =
        submission.notifiedOutcome !== null &&
        (submission.notifiedOutcome !== submission.outcome ||
          submission.notifiedDecisionTypeId !== submission.decisionTypeId);
      const note = dto.note !== undefined ? dto.note : submission.decisionNote;
      const shareIds = dto.shareReviewIds ?? [];
      if (
        (await this.reviews.shareReviews(tx, submissionId, shareIds)) !==
        shareIds.length
      ) {
        throw AppException.validation(
          'Some of these reviews are not reviews of this paper.',
        );
      }
      await this.submissions.update(tx, submissionId, {
        notifiedOutcome: submission.outcome,
        notifiedDecisionTypeId: submission.decisionTypeId,
        notifiedNote: note,
        decisionNote: note,
        notifiedAt: new Date(),
      });

      const label =
        (await this.reviews.decisionTypeLabel(tx, submission.decisionTypeId)) ??
        submission.outcome;
      const ctx = await this.papers.context(tx, user, info, submissionId);
      const pid = paperId(info.acronym, submission.paperNo);
      await this.notifications.notify(
        tx,
        await this.submissions.linkedUserIds(tx, submissionId),
        {
          kind: 'decision',
          title: `Decision: ${label}`,
          body: note,
          conferenceId: submission.conferenceId,
          submissionId,
          link: `/submissions/${pid}/author`,
        },
      );

      const sent = await this.reviews.submittedReviews(tx, submissionId);
      const people = await this.recipients.people(
        tx,
        sent.map((r) => r.reviewerId),
      );
      const dates = await this.reviews.conferenceDates(
        tx,
        submission.conferenceId,
      );
      const queued = await this.emails.enqueue(
        tx,
        'decision_notified',
        await this.reviewEmails.decision(tx, ctx, {
          outcome: submission.outcome,
          label,
          note,
          changed,
          shared: sent.filter((r) => r.sharedWithAuthor),
          reviewers: [...people.values()],
          cameraReadyDeadline: dates?.cameraReadyDeadline ?? null,
          notificationDate: dates?.notificationDate ?? null,
          registrationUrl: info.registrationUrl,
          registrationDeadline: info.registrationDeadline,
        }),
        { sentBy: user.id },
      );
      await this.audit.record(
        {
          action: 'submission.decision_notified',
          actorId: user.id,
          entityType: 'submission',
          entityId: submissionId,
          client,
          data: {
            outcome: submission.outcome,
            decisionTypeId: submission.decisionTypeId,
            changed,
            sharedReviews: shareIds,
          },
        },
        tx,
      );
      return {
        submission: await this.papers.view(tx, user, submissionId),
        ...queued,
        changed,
      };
    });
  }

  /** The conference's decision types, in order (team, super admins and the conference's authors). */
  async decisionTypes(
    user: AuthUser,
    conferenceId: string,
  ): Promise<DecisionTypeResponse[]> {
    const access = await this.access.requireConference(user, conferenceId);
    if (!rules.canViewDecisionTypes(access)) {
      throw AppException.forbidden();
    }
    return (
      await this.reviews.decisionTypes(this.database.db, conferenceId)
    ).map(toDecisionType);
  }

  /**
   * Replaces the list (chairs): types sent with an id are changed, new ones added, the rest
   * removed. A type that a paper uses can't be removed.
   */
  async replaceDecisionTypes(
    user: AuthUser,
    conferenceId: string,
    dto: DecisionTypesDto,
    client: ClientInfo,
  ): Promise<DecisionTypeResponse[]> {
    return this.database.transaction(async (tx) => {
      const access = await this.access.requireConference(
        user,
        conferenceId,
        tx,
      );
      if (!rules.canManageDecisionTypes(access)) {
        throw AppException.forbidden(
          'Only a chair of this conference can change its decision types.',
        );
      }
      const existing = await this.reviews.decisionTypes(tx, conferenceId);
      const known = new Set(existing.map((t) => t.id));
      const sentIds = dto.types.flatMap((t) => (t.id ? [t.id] : []));
      if (sentIds.some((id) => !known.has(id))) {
        throw AppException.validation(
          'Unknown decision type for this conference.',
        );
      }
      if (new Set(sentIds).size !== sentIds.length) {
        throw AppException.validation('A decision type is in the list twice.');
      }
      const removed = existing.filter((t) => !sentIds.includes(t.id));
      const use = await this.reviews.decisionTypeUse(
        tx,
        removed.map((t) => t.id),
      );
      const inUse = removed.find((t) => (use.get(t.id) ?? 0) > 0);
      if (inUse) {
        const n = use.get(inUse.id)!;
        throw AppException.businessRule(
          `"${inUse.label}" is used by ${n} paper${n === 1 ? '' : 's'}, so it can't be removed.`,
        );
      }

      const rows = dto.types.map((t, position) => ({
        conferenceId,
        label: t.label,
        color:
          t.color ??
          existing.find((e) => e.id === t.id)?.color ??
          DEFAULT_COLOR,
        outcome: t.outcome,
        description: t.description ?? null,
        position,
        ...(t.id ? { id: t.id } : {}),
      }));
      await this.reviews.replaceDecisionTypes(
        tx,
        conferenceId,
        rows.filter(
          (r): r is typeof r & { id: string } =>
            'id' in r && typeof r.id === 'string',
        ),
        rows.filter((r) => !('id' in r)),
        removed.map((t) => t.id),
      );
      await this.audit.record(
        {
          action: 'conference.decision_types_updated',
          actorId: user.id,
          entityType: 'conference',
          entityId: conferenceId,
          client,
          data: { count: rows.length, removed: removed.map((t) => t.label) },
        },
        tx,
      );
      return (await this.reviews.decisionTypes(tx, conferenceId)).map(
        toDecisionType,
      );
    });
  }
}
