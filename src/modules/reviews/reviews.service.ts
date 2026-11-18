import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { conferences, submissions } from '../../core/database/schema/index.js';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Executor, Tx } from '../../core/database/database.types.js';
import { EmailQueueService } from '../../core/email/email-queue.service.js';
import { EmailRecipientsService } from '../../core/email/email-recipients.service.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import { NotificationsService } from '../../core/notifications/notifications.service.js';
import * as rules from '../../core/rbac/access-rules.js';
import type { SubmissionAccess } from '../../core/rbac/access-rules.js';
import { AccessService } from '../../core/rbac/access.service.js';
import type { PaperContext } from '../submissions/submission-emails.service.js';
import { paperId } from '../submissions/submission.mapper.js';
import { SubmissionsRepository } from '../submissions/submissions.repository.js';
import { SubmissionsService } from '../submissions/submissions.service.js';
import type {
  ReviewFormResponse,
  AssignmentResponse,
  AssignReviewersDto,
  MyAssignmentResponse,
  PaperReviewsResponse,
  RespondToAssignmentDto,
  ReviewFieldsDto,
  ReviewBoardResponse,
  ReviewResponse,
  SaveReviewDto,
  SaveReviewResponse,
} from './dto/review.dto.js';
import { ReviewEmailsService } from './review-emails.service.js';
import {
  summarize,
  toAssignment,
  toAuthorReviews,
  toPending,
  toReview,
} from './review.mapper.js';
import {
  type AssignmentRow,
  type MemberRow,
  ReviewsRepository,
} from './reviews.repository.js';

/** The review form as stored: a save replaces the whole form, as the app sends it whole. */
function reviewValues(dto: ReviewFieldsDto) {
  return {
    score: dto.score ?? null,
    confidence: dto.confidence ?? null,
    recommendation: dto.recommendation ?? null,
    commentsToAuthor: dto.commentsToAuthor ?? null,
    commentsToChair: dto.commentsToChair ?? null,
    answers: dto.answers ?? {},
  };
}

const endOfDay = (date: string | null | undefined) =>
  date ? new Date(`${date}T23:59:59Z`) : null;

const memberLabel = (m: MemberRow) =>
  m.displayName?.trim() || m.invitedEmail || 'This person';

/**
 * Peer review: chairs give papers to reviewers (or queue them for invited reviewers), reviewers
 * accept or decline and write their review, chairs correct, share or write reviews themselves.
 * Every change and its notifications and emails are saved in one transaction.
 *
 * Replaces: respond_to_assignment, set_review_shared, chair_submit_review, chair_edit_review,
 * notify_review_assigned, handle_review_submitted, the author_reviews view, and the
 * reviews_assigned / review_submitted / review_edited_by_chair emails of the old app.
 */
@Injectable()
export class ReviewsService {
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

  // Reading -----------------------------------------------------------------------------------

  /**
   * A paper's reviews as the user may see them: chairs everything, a reviewer their own
   * assignment, authors the reviews the chair shared (anonymised).
   */
  async paperReviews(
    user: AuthUser,
    submissionId: string,
    executor: Executor = this.database.db,
  ): Promise<PaperReviewsResponse> {
    const access = await this.access.requireSubmission(
      user,
      submissionId,
      executor,
    );
    if (rules.canManageReviews(access)) {
      const bundles = await this.reviews.assignmentsOf(executor, {
        submissionId,
      });
      return {
        submissionId,
        view: 'chair',
        assignments: bundles.map((b) =>
          toAssignment(b, b.assignment.reviewerId === user.id ? access : null),
        ),
        pending: (await this.reviews.pendingOf(executor, submissionId)).map(
          toPending,
        ),
        authorReviews: [],
        summary: summarize(bundles),
      };
    }
    if (rules.isAuthorOf(access)) {
      return {
        submissionId,
        view: 'author',
        assignments: [],
        pending: [],
        authorReviews: toAuthorReviews(
          await this.reviews.submittedReviews(executor, submissionId),
        ),
        summary: null,
      };
    }
    const own = await this.reviews.assignmentsOf(executor, {
      submissionId,
      reviewerId: user.id,
    });
    return {
      submissionId,
      view: 'reviewer',
      assignments: own.map((b) => toAssignment(b, access)),
      pending: [],
      authorReviews: [],
      summary: null,
    };
  }

  /** The chair's review board: every submitted paper of the conference with its reviewers, their reviews and who is still to join. */
  async reviewBoard(
    user: AuthUser,
    conferenceId: string,
  ): Promise<ReviewBoardResponse> {
    const db = this.database.db;
    const access = await this.access.requireConference(user, conferenceId, db);
    if (!rules.isChair(access)) {
      throw AppException.forbidden(
        'Only a chair of this conference can see its review board.',
      );
    }
    const [ids, assignments, pending] = await Promise.all([
      this.reviews.submittedPaperIds(db, conferenceId),
      this.reviews.assignmentsOfConference(db, conferenceId),
      this.reviews.pendingOfConference(db, conferenceId),
    ]);
    return {
      conferenceId,
      papers: ids.map((submissionId) => ({
        submissionId,
        assignments: assignments
          .filter((b) => b.assignment.submissionId === submissionId)
          .map((b) => toAssignment(b, null)),
        pending: pending
          .filter((p) => p.pending.submissionId === submissionId)
          .map(toPending),
      })),
    };
  }

  /** The reviewer's queue: every paper given to them (in one conference, or all). */
  async myAssignments(
    user: AuthUser,
    conferenceId?: string,
  ): Promise<MyAssignmentResponse[]> {
    const db = this.database.db;
    const rows = await this.reviews.myAssignments(db, user.id, conferenceId);
    const bundles = new Map(
      (
        await this.reviews.assignmentsOf(db, {
          ids: rows.map((r) => r.assignmentId),
        })
      ).map((b) => [b.assignment.id, b]),
    );
    const result: MyAssignmentResponse[] = [];
    for (const row of rows) {
      const bundle = bundles.get(row.assignmentId);
      const access = await this.access.submissionAccess(
        user,
        row.submission.id,
        db,
      );
      if (!bundle || !access || !rules.canViewSubmission(access)) {
        continue;
      }
      const details = row.submission.details as Record<string, unknown>;
      result.push(
        Object.assign(toAssignment(bundle, access), {
          paper: {
            id: row.submission.id,
            paperId: paperId(row.conference.acronym, row.submission.paperNo),
            title: row.submission.title,
            abstract: row.submission.abstract,
            keywords: row.submission.keywords,
            track: typeof details.track === 'string' ? details.track : null,
            presentationType:
              typeof details.presentationType === 'string'
                ? details.presentationType
                : null,
            conferenceId: row.submission.conferenceId,
            conferenceSlug: row.conference.slug,
            conferenceAcronym: row.conference.acronym,
            outcome: row.submission.outcome,
            withdrawn: row.submission.status === 'withdrawn',
          },
        }),
      );
    }
    return result;
  }

  /** One assignment: its reviewer, or a chair of the conference. 404 for anyone else. */
  async assignment(
    user: AuthUser,
    assignmentId: string,
  ): Promise<AssignmentResponse> {
    const db = this.database.db;
    const bundle = await this.reviews.assignmentOf(db, assignmentId);
    const access =
      bundle &&
      (await this.access.submissionAccess(
        user,
        bundle.assignment.submissionId,
        db,
      ));
    const own = bundle?.assignment.reviewerId === user.id;
    if (
      !bundle ||
      !access ||
      !rules.canViewSubmission(access) ||
      !(own || rules.canManageReviews(access))
    ) {
      throw AppException.notFound('The review assignment');
    }
    return toAssignment(bundle, own ? access : null);
  }

  /**
   * The review form of one assignment: the conference's own form and instructions (kept in its
   * chair-only settings, so they are read here on the reviewer's behalf) and the decision once
   * the authors were told. The assignment's reviewer, or a chair.
   */
  async reviewForm(
    user: AuthUser,
    assignmentId: string,
  ): Promise<ReviewFormResponse> {
    const db = this.database.db;
    const bundle = await this.reviews.assignmentOf(db, assignmentId);
    const access =
      bundle &&
      (await this.access.submissionAccess(
        user,
        bundle.assignment.submissionId,
        db,
      ));
    const own = bundle?.assignment.reviewerId === user.id;
    if (
      !bundle ||
      !access ||
      !rules.canViewSubmission(access) ||
      !(own || rules.canManageReviews(access))
    ) {
      throw AppException.notFound('The review assignment');
    }
    const conferenceId = access.conference.conferenceId;
    const [conference] = await db
      .select({ settings: conferences.settings })
      .from(conferences)
      .where(eq(conferences.id, conferenceId));
    const settings = obj(conference?.settings);
    const form = obj(settings.reviewForm);
    const instructions = obj(settings.reviewInstructions);
    const pdf = obj(instructions.pdf);

    let decision: ReviewFormResponse['decision'] = null;
    if (access.notifiedOutcome) {
      const [paper] = await db
        .select({ typeId: submissions.notifiedDecisionTypeId })
        .from(submissions)
        .where(eq(submissions.id, access.submissionId));
      const type = (await this.reviews.decisionTypes(db, conferenceId)).find(
        (t) => t.id === paper?.typeId,
      );
      decision = {
        outcome: access.notifiedOutcome,
        label: type?.label ?? null,
        color: type?.color ?? null,
      };
    }
    return {
      form: Array.isArray(form.sections) ? form : null,
      instructions: {
        text: typeof instructions.text === 'string' ? instructions.text : '',
        mode: instructions.mode === 'pdf' ? 'pdf' : 'html',
        pdf:
          typeof pdf.path === 'string' && pdf.path
            ? {
                path: pdf.path,
                name:
                  typeof pdf.name === 'string' && pdf.name
                    ? pdf.name
                    : 'Reviewer instructions.pdf',
              }
            : null,
      },
      decision,
    };
  }

  // Chairs assign -------------------------------------------------------------------------------

  /**
   * Gives the paper to committee members: active reviewers get it now ("Papers assigned to you"),
   * invited reviewers get it when they accept the committee invitation. Someone who declined or
   * was taken off the paper gets it again; someone who already has it is left as they are.
   */
  async assign(
    user: AuthUser,
    submissionId: string,
    dto: AssignReviewersDto,
    client: ClientInfo,
  ): Promise<PaperReviewsResponse> {
    return this.database.transaction(async (tx) => {
      const { submission } = await this.lockPaper(
        tx,
        user,
        submissionId,
        'manage',
      );
      if (submission.status === 'withdrawn') {
        throw AppException.businessRule(
          'This paper has been withdrawn, so it takes no reviewers.',
        );
      }
      const members = await this.reviews.members(
        tx,
        submission.conferenceId,
        dto.memberIds,
      );
      if (members.length !== dto.memberIds.length) {
        throw AppException.validation(
          "Some of these people aren't on this conference's committee.",
        );
      }
      const authors = await this.reviews.authorAccounts(tx, submissionId);
      const now: MemberRow[] = [];
      const later: MemberRow[] = [];
      for (const member of members) {
        const kind = rules.reviewerAssignment(member);
        if (kind === null) {
          throw AppException.businessRule(
            `${memberLabel(member)} isn't an active or invited reviewer of this conference.`,
          );
        }
        if (member.userId && authors.has(member.userId)) {
          throw AppException.businessRule(
            `${memberLabel(member)} is an author of this paper, so they can't review it.`,
          );
        }
        (kind === 'assign' && member.userId ? now : later).push(member);
      }

      const dueAt = endOfDay(dto.dueDate);
      const existing = await this.reviews.existingAssignments(
        tx,
        submissionId,
        now.map((m) => m.userId!),
      );
      const given: AssignmentRow[] = [];
      for (const member of now) {
        const found = existing.find((a) => a.reviewerId === member.userId);
        if (!found) {
          given.push(
            await this.reviews.insertAssignment(tx, {
              submissionId,
              reviewerId: member.userId!,
              dueAt,
              assignedBy: user.id,
            }),
          );
        } else if (found.status === 'declined' || found.status === 'removed') {
          given.push(
            await this.reviews.updateAssignment(tx, found.id, {
              status: 'assigned',
              dueAt,
              assignedBy: user.id,
              assignedAt: new Date(),
              respondedAt: null,
              declineReason: null,
            }),
          );
        }
      }
      for (const member of later) {
        await this.reviews.upsertPending(tx, {
          submissionId,
          memberId: member.id,
          dueAt,
          assignedBy: user.id,
        });
      }

      if (given.length > 0) {
        const ctx = await this.context(
          tx,
          user,
          submission.conferenceId,
          submissionId,
        );
        const pid = paperId(ctx.conference.acronym, submission.paperNo);
        for (const a of given) {
          await this.notifications.notify(tx, [a.reviewerId], {
            kind: 'review_assigned',
            title: `New paper to review: ${pid}`,
            body: submission.title,
            conferenceId: submission.conferenceId,
            submissionId,
            link: `/reviews/${a.id}`,
          });
        }
        const people = await this.recipients.people(
          tx,
          given.map((a) => a.reviewerId),
        );
        const dates = await this.reviews.conferenceDates(
          tx,
          submission.conferenceId,
        );
        await this.emails.enqueue(
          tx,
          'reviews_assigned',
          this.reviewEmails.assigned(
            ctx,
            given.flatMap((a) => {
              const person = people.get(a.reviewerId);
              return person ? [{ person, dueAt: a.dueAt }] : [];
            }),
            dates?.reviewDeadline ?? null,
          ),
          { sentBy: user.id },
        );
      }
      await this.record(
        tx,
        user,
        client,
        'review.assigned',
        'submission',
        submissionId,
        {
          assigned: given.map((a) => a.reviewerId),
          waiting: later.map((m) => m.id),
        },
      );
      return this.paperReviews(user, submissionId, tx);
    });
  }

  /**
   * Takes the paper away from a reviewer. A sent review stays on record (but no longer counts); a
   * reviewer still working on it is told it left their queue.
   */
  async unassign(
    user: AuthUser,
    assignmentId: string,
    client: ClientInfo,
  ): Promise<PaperReviewsResponse> {
    return this.database.transaction(async (tx) => {
      const assignment = await this.reviews.assignmentForUpdate(
        tx,
        assignmentId,
      );
      if (!assignment) {
        throw AppException.notFound('The review assignment');
      }
      const { submission } = await this.lockPaper(
        tx,
        user,
        assignment.submissionId,
        'manage',
        'The review assignment',
      );
      if (assignment.status === 'removed') {
        throw AppException.businessRule(
          'This reviewer was already taken off the paper.',
        );
      }
      await this.reviews.updateAssignment(tx, assignment.id, {
        status: 'removed',
      });
      const review = await this.reviews.reviewForAssignment(tx, assignment.id);
      const stillWorking =
        assignment.status !== 'declined' && review?.status !== 'submitted';
      if (stillWorking && assignment.reviewerId !== user.id) {
        const ctx = await this.context(
          tx,
          user,
          submission.conferenceId,
          submission.id,
        );
        await this.notifications.notify(tx, [assignment.reviewerId], {
          kind: 'assignment_removed',
          title: `${paperId(ctx.conference.acronym, submission.paperNo)} was removed from your queue`,
          body: submission.title,
          conferenceId: submission.conferenceId,
          submissionId: submission.id,
        });
        const reviewer = (
          await this.recipients.people(tx, [assignment.reviewerId])
        ).get(assignment.reviewerId);
        if (reviewer) {
          await this.emails.enqueue(
            tx,
            'assignment_removed',
            this.reviewEmails.removed(ctx, reviewer),
            {
              sentBy: user.id,
            },
          );
        }
      }
      await this.record(
        tx,
        user,
        client,
        'review.unassigned',
        'submission',
        submission.id,
        {
          assignmentId,
          reviewerId: assignment.reviewerId,
        },
      );
      return this.paperReviews(user, submission.id, tx);
    });
  }

  /** Drops a paper waiting for an invited reviewer. */
  async removePending(
    user: AuthUser,
    pendingId: string,
    client: ClientInfo,
  ): Promise<PaperReviewsResponse> {
    return this.database.transaction(async (tx) => {
      const row = await this.reviews.pendingById(tx, pendingId);
      if (!row) {
        throw AppException.notFound('The waiting assignment');
      }
      await this.lockPaper(
        tx,
        user,
        row.pending.submissionId,
        'manage',
        'The waiting assignment',
      );
      await this.reviews.deletePending(tx, pendingId);
      await this.record(
        tx,
        user,
        client,
        'review.pending_removed',
        'submission',
        row.pending.submissionId,
        {
          memberId: row.pending.memberId,
        },
      );
      return this.paperReviews(user, row.pending.submissionId, tx);
    });
  }

  // Reviewers -----------------------------------------------------------------------------------

  /** The reviewer accepts or declines a paper given to them. Chairs hear about a decline. */
  async respond(
    user: AuthUser,
    assignmentId: string,
    dto: RespondToAssignmentDto,
    client: ClientInfo,
  ): Promise<AssignmentResponse> {
    return this.database.transaction(async (tx) => {
      const { assignment, access, submission } = await this.ownAssignment(
        tx,
        user,
        assignmentId,
      );
      if (assignment.status !== 'assigned') {
        throw AppException.businessRule(
          'You have already answered for this paper.',
        );
      }
      if (submission.status === 'withdrawn') {
        throw AppException.businessRule('This paper has been withdrawn.');
      }
      await this.reviews.updateAssignment(tx, assignment.id, {
        status: dto.accept ? 'accepted' : 'declined',
        respondedAt: new Date(),
        declineReason: dto.accept ? null : (dto.reason ?? null),
      });
      if (!dto.accept) {
        const me = (await this.recipients.people(tx, [user.id])).get(user.id);
        await this.notifications.notifyChairs(tx, submission.conferenceId, {
          kind: 'assignment_declined',
          title: `${me?.name ?? 'A reviewer'} declined a paper: ${submission.title}`,
          body: dto.reason ?? null,
          submissionId: submission.id,
        });
      }
      await this.record(
        tx,
        user,
        client,
        dto.accept ? 'review.accepted' : 'review.declined',
        'submission',
        submission.id,
        {
          assignmentId,
        },
      );
      return this.reloadAssignment(tx, user, assignment.id, access);
    });
  }

  /**
   * Saves the reviewer's form: a draft, or sent to the chairs. A sent review can be corrected
   * (sent again) until the paper has a decision; a draft save never takes a sent review back.
   * The first time it is sent the assignment is done and the thank-you, chair and "ready for
   * decision" emails go out.
   */
  async saveReview(
    user: AuthUser,
    assignmentId: string,
    dto: SaveReviewDto,
    client: ClientInfo,
  ): Promise<SaveReviewResponse> {
    return this.database.transaction(async (tx) => {
      const { assignment, access, submission } = await this.ownAssignment(
        tx,
        user,
        assignmentId,
      );
      const existing = await this.reviews.reviewForAssignment(
        tx,
        assignment.id,
      );
      if (existing?.status === 'submitted' && !dto.submit) {
        return Object.assign(
          await this.reloadAssignment(tx, user, assignment.id, access),
          { firstSubmit: false },
        );
      }
      const allowed = existing
        ? rules.canEditOwnReview(access)
        : rules.canWriteReview(access) && rules.canEditOwnReview(access);
      if (!allowed) {
        throw AppException.businessRule(
          submission.status === 'withdrawn'
            ? 'This paper has been withdrawn, so its review can no longer be changed.'
            : rules.REVIEW_EDITABLE_OUTCOMES.includes(
                  submission.outcome as (typeof rules.REVIEW_EDITABLE_OUTCOMES)[number],
                )
              ? 'This paper is no longer open for your review.'
              : "This review can't be changed any more — the paper already has a decision.",
        );
      }
      const firstSubmit = dto.submit && existing?.status !== 'submitted';
      const values = {
        ...reviewValues(dto),
        status: dto.submit ? ('submitted' as const) : ('draft' as const),
        submittedAt: firstSubmit ? new Date() : (existing?.submittedAt ?? null),
      };
      const review = existing
        ? await this.reviews.updateReview(tx, existing.id, values)
        : await this.reviews.insertReview(tx, {
            ...values,
            assignmentId: assignment.id,
            submissionId: submission.id,
            reviewerId: user.id,
          });

      if (firstSubmit) {
        await this.reviews.updateAssignment(tx, assignment.id, {
          status: 'submitted',
          respondedAt: assignment.respondedAt ?? new Date(),
        });
        const ctx = await this.context(
          tx,
          user,
          submission.conferenceId,
          submission.id,
        );
        const pid = paperId(ctx.conference.acronym, submission.paperNo);
        await this.notifications.notifyChairs(tx, submission.conferenceId, {
          kind: 'review_submitted',
          title: `New review of ${pid}`,
          body: `${ctx.actor.name} sent a review of ${submission.title}`,
          submissionId: submission.id,
          link: `/submissions/${pid}/chair/review`,
        });
        await this.emails.enqueue(
          tx,
          'review_submitted',
          await this.reviewEmails.submitted(
            tx,
            ctx,
            review,
            ctx.actor,
            await this.reviews.reviewProgress(tx, submission.id),
          ),
          { sentBy: user.id },
        );
      }
      await this.record(
        tx,
        user,
        client,
        dto.submit ? 'review.submitted' : 'review.draft_saved',
        'review',
        review.id,
        {
          submissionId: submission.id,
          firstSubmit,
        },
      );
      return Object.assign(
        await this.reloadAssignment(tx, user, assignment.id, access),
        { firstSubmit },
      );
    });
  }

  // Chairs and reviews --------------------------------------------------------------------------

  /** A chair corrects a review the reviewer has sent; the reviewer is told (not for their own). */
  async chairEdit(
    user: AuthUser,
    reviewId: string,
    dto: ReviewFieldsDto,
    client: ClientInfo,
  ): Promise<AssignmentResponse> {
    return this.database.transaction(async (tx) => {
      const review = await this.reviews.reviewForUpdate(tx, reviewId);
      if (!review) {
        throw AppException.notFound('The review');
      }
      const { access, submission } = await this.lockPaper(
        tx,
        user,
        review.submissionId,
        'manage',
        'The review',
      );
      if (!rules.canChairEditReview(access, review.status)) {
        throw AppException.businessRule(
          review.status !== 'submitted'
            ? 'Only a review the reviewer has sent can be edited.'
            : 'This paper has been withdrawn, so its reviews can no longer be changed.',
        );
      }
      await this.reviews.updateReview(tx, review.id, {
        ...reviewValues(dto),
        editedByChairAt: new Date(),
      });
      if (review.reviewerId !== user.id) {
        const ctx = await this.context(
          tx,
          user,
          submission.conferenceId,
          submission.id,
        );
        await this.notifications.notify(tx, [review.reviewerId], {
          kind: 'review_edited',
          title: `The chair edited your review of ${paperId(ctx.conference.acronym, submission.paperNo)}`,
          body: 'Open the review to see the updated version.',
          conferenceId: submission.conferenceId,
          submissionId: submission.id,
          link: `/reviews/${review.assignmentId}`,
        });
        const reviewer = (
          await this.recipients.people(tx, [review.reviewerId])
        ).get(review.reviewerId);
        if (reviewer) {
          await this.emails.enqueue(
            tx,
            'review_edited_by_chair',
            this.reviewEmails.editedByChair(ctx, reviewer),
            { sentBy: user.id },
          );
        }
      }
      await this.record(
        tx,
        user,
        client,
        'review.edited_by_chair',
        'review',
        review.id,
        {
          submissionId: submission.id,
        },
      );
      return this.reloadAssignment(tx, user, review.assignmentId, null);
    });
  }

  /**
   * A chair reviews the paper themselves: the first save creates their (already accepted)
   * assignment and sent review, later saves change it. It counts like any other review.
   */
  async chairReview(
    user: AuthUser,
    submissionId: string,
    dto: ReviewFieldsDto,
    client: ClientInfo,
  ): Promise<AssignmentResponse> {
    return this.database.transaction(async (tx) => {
      const { access } = await this.lockPaper(tx, user, submissionId, 'manage');
      if (!rules.canReviewAsChair(access)) {
        throw AppException.businessRule("This paper isn't open for review.");
      }
      const [found] = await this.reviews.existingAssignments(tx, submissionId, [
        user.id,
      ]);
      let assignment = found;
      if (!assignment) {
        assignment = await this.reviews.insertAssignment(tx, {
          submissionId,
          reviewerId: user.id,
          status: 'accepted',
          respondedAt: new Date(),
          assignedBy: null,
        });
      } else if (
        assignment.status === 'declined' ||
        assignment.status === 'removed'
      ) {
        assignment = await this.reviews.updateAssignment(tx, assignment.id, {
          status: 'accepted',
          respondedAt: new Date(),
        });
      }
      const existing = await this.reviews.reviewForAssignment(
        tx,
        assignment.id,
      );
      const values = {
        ...reviewValues(dto),
        status: 'submitted' as const,
        submittedAt: existing?.submittedAt ?? new Date(),
      };
      const review = existing
        ? await this.reviews.updateReview(tx, existing.id, values)
        : await this.reviews.insertReview(tx, {
            ...values,
            assignmentId: assignment.id,
            submissionId,
            reviewerId: user.id,
          });
      if (assignment.status !== 'submitted') {
        await this.reviews.updateAssignment(tx, assignment.id, {
          status: 'submitted',
        });
      }
      await this.record(
        tx,
        user,
        client,
        'review.chair_review_saved',
        'review',
        review.id,
        {
          submissionId,
        },
      );
      return this.reloadAssignment(
        tx,
        user,
        assignment.id,
        await this.access.requireSubmission(user, submissionId, tx),
      );
    });
  }

  /** Shows a review to the authors (anonymised), or hides it again. */
  async share(
    user: AuthUser,
    reviewId: string,
    shared: boolean,
    client: ClientInfo,
  ): Promise<ReviewResponse> {
    return this.database.transaction(async (tx) => {
      const review = await this.reviews.reviewForUpdate(tx, reviewId);
      if (!review) {
        throw AppException.notFound('The review');
      }
      await this.lockPaper(
        tx,
        user,
        review.submissionId,
        'manage',
        'The review',
      );
      if (shared && review.status !== 'submitted') {
        throw AppException.businessRule(
          'Only a review the reviewer has sent can be shared.',
        );
      }
      const updated = await this.reviews.updateReview(tx, review.id, {
        sharedWithAuthor: shared,
      });
      await this.record(
        tx,
        user,
        client,
        shared ? 'review.shared' : 'review.unshared',
        'review',
        review.id,
        {
          submissionId: review.submissionId,
        },
      );
      return toReview(updated);
    });
  }

  // Helpers -----------------------------------------------------------------------------------

  /**
   * The paper locked for a change and the user's standing on it. `manage` requires a chair
   * (404 for someone who can't see the paper, 403 for a non-chair who can).
   */
  private async lockPaper(
    tx: Tx,
    user: AuthUser,
    submissionId: string,
    need: 'manage',
    notFound = 'The paper',
  ) {
    const submission = await this.submissions.findForUpdate(tx, submissionId);
    const access = submission
      ? await this.access.submissionAccess(user, submissionId, tx)
      : undefined;
    if (!submission || !access || !rules.canViewSubmission(access)) {
      throw AppException.notFound(notFound);
    }
    if (need === 'manage' && !rules.canManageReviews(access)) {
      throw AppException.forbidden(
        'Only a chair of this conference can manage its reviews.',
      );
    }
    return { submission, access };
  }

  /** The user's own assignment, locked with its paper. 404 for anyone else's. */
  private async ownAssignment(tx: Tx, user: AuthUser, assignmentId: string) {
    const assignment = await this.reviews.assignmentForUpdate(tx, assignmentId);
    if (!assignment || assignment.reviewerId !== user.id) {
      throw AppException.notFound('The review assignment');
    }
    const submission = (await this.submissions.findForUpdate(
      tx,
      assignment.submissionId,
    ))!;
    const access = await this.access.submissionAccess(
      user,
      assignment.submissionId,
      tx,
    );
    if (!access || !rules.canViewSubmission(access)) {
      throw AppException.notFound('The review assignment');
    }
    return { assignment, access, submission };
  }

  private async reloadAssignment(
    executor: Executor,
    user: AuthUser,
    assignmentId: string,
    access: SubmissionAccess | null,
  ): Promise<AssignmentResponse> {
    const bundle = (await this.reviews.assignmentOf(executor, assignmentId))!;
    const own = bundle.assignment.reviewerId === user.id;
    // The access was read before the change: read it again so `can` reflects the new state.
    const fresh =
      own && access
        ? await this.access.submissionAccess(
            user,
            bundle.assignment.submissionId,
            executor,
          )
        : null;
    return toAssignment(bundle, fresh ?? null);
  }

  private async context(
    executor: Executor,
    user: AuthUser,
    conferenceId: string,
    submissionId: string,
  ): Promise<PaperContext> {
    const info = (await this.submissions.conferenceInfo(
      executor,
      conferenceId,
    ))!;
    return this.papers.context(executor, user, info, submissionId);
  }

  private record(
    tx: Tx,
    user: AuthUser,
    client: ClientInfo,
    action: string,
    entityType: string,
    entityId: string,
    data: Record<string, unknown> = {},
  ) {
    return this.audit.record(
      { action, actorId: user.id, entityType, entityId, client, data },
      tx,
    );
  }
}

/** A JSON value as a plain object ({} for anything else). */
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
