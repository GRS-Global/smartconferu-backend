import { Injectable } from '@nestjs/common';
import type { Executor } from '../../core/database/database.types.js';
import {
  emailDate,
  escapeHtml,
  firstName,
} from '../../core/email/email-render.js';
import type { TemplateEmail } from '../../core/email/email-queue.service.js';
import {
  EmailRecipientsService,
  type Person,
} from '../../core/email/email-recipients.service.js';
import type { DecisionOutcome } from '../../core/rbac/access-rules.js';
import {
  type PaperContext,
  SubmissionEmailsService,
} from '../submissions/submission-emails.service.js';
import { paperId } from '../submissions/submission.mapper.js';
import { averageScore } from './review.mapper.js';
import type { ReviewRow } from './reviews.repository.js';

/** The template the authors get for each decision told to them. */
const DECISION_TEMPLATES: Partial<Record<DecisionOutcome, string>> = {
  accept: 'acceptance',
  registered: 'acceptance',
  revise: 'minorRevision',
  reject: 'rejection',
  waitlist: 'waitlisted',
};

const multiline = (text: string) => escapeHtml(text).replace(/\n/g, '<br>');

/**
 * The emails of peer review and decisions, as the app's old src/shared/emailRequest.js built them
 * (reviews_assigned, review_submitted, review_edited_by_chair, decision_notified). The callers
 * queue them in the transaction of the change.
 */
@Injectable()
export class ReviewEmailsService {
  constructor(
    private readonly recipients: EmailRecipientsService,
    private readonly paperEmails: SubmissionEmailsService,
  ) {}

  private pid(ctx: PaperContext) {
    return paperId(ctx.conference.acronym, ctx.submission.paperNo);
  }

  private base(ctx: PaperContext) {
    return { conference: ctx.conference, submissionId: ctx.submission.id };
  }

  private reviewerLink(ctx: PaperContext) {
    return this.recipients.link(`/prototype/reviewer/${ctx.conference.slug}`);
  }

  /** "Papers assigned to you", one per reviewer given the paper. */
  assigned(
    ctx: PaperContext,
    reviewers: readonly { person: Person; dueAt: Date | null }[],
    reviewDeadline: Date | null,
  ): TemplateEmail[] {
    return reviewers.map(({ person, dueAt }) => ({
      ...this.base(ctx),
      template: 'reviewAssignment',
      recipientType: 'Reviewer',
      to: person,
      values: {
        first_name: firstName(person.name, person.email),
        paper_list: `${escapeHtml(this.pid(ctx))} · ${escapeHtml(ctx.submission.title)}`,
        review_deadline:
          emailDate(dueAt) ||
          emailDate(reviewDeadline) ||
          'the date the chair set',
        review_link: this.reviewerLink(ctx),
      },
    }));
  }

  /** "Removed from your queue": a chair took the paper back before the review was sent. */
  removed(ctx: PaperContext, reviewer: Person): TemplateEmail {
    return {
      ...this.base(ctx),
      template: 'assignmentRemoved',
      recipientType: 'Reviewer',
      to: reviewer,
      values: {
        first_name: firstName(reviewer.name, reviewer.email),
        paper_title: ctx.submission.title,
      },
    };
  }

  /**
   * A review was sent: thanks to the reviewer, "New review" to the chairs, and "Ready for decision"
   * once every assigned review is in.
   */
  async submitted(
    executor: Executor,
    ctx: PaperContext,
    review: ReviewRow,
    reviewer: Person,
    progress: { active: number; submitted: ReviewRow[] },
  ): Promise<TemplateEmail[]> {
    const chairs = await this.recipients.chairs(executor, ctx.conference.id);
    const score =
      typeof review.score === 'number' ? `${review.score} / 5` : '—';
    const emails: TemplateEmail[] = [
      {
        ...this.base(ctx),
        template: 'reviewThanks',
        recipientType: 'Reviewer',
        to: reviewer,
        values: {
          first_name: firstName(reviewer.name, reviewer.email),
          paper_title: ctx.submission.title,
          review_copy: `Score ${escapeHtml(score)}${
            review.commentsToAuthor
              ? ` · ${multiline(review.commentsToAuthor)}`
              : ''
          }`,
        },
      },
      ...chairs.map((c): TemplateEmail => ({
        ...this.base(ctx),
        template: 'reviewSubmittedChair',
        recipientType: 'Chair',
        to: c,
        values: {
          first_name: firstName(c.name, c.email),
          paper_title: ctx.submission.title,
          reviewer_name: reviewer.name,
          score,
        },
      })),
    ];
    if (progress.active > 0 && progress.submitted.length >= progress.active) {
      const scores = progress.submitted
        .map((r) => r.score)
        .filter((s): s is number => typeof s === 'number');
      const avg = averageScore(progress.submitted);
      for (const c of chairs) {
        emails.push({
          ...this.base(ctx),
          template: 'chairDecisionReady',
          recipientType: 'Chair',
          to: c,
          values: {
            first_name: firstName(c.name, c.email),
            paper_title: ctx.submission.title,
            avg_score: avg === null ? '—' : `${avg.toFixed(1)} / 5`,
            score_spread:
              scores.length > 0
                ? `${Math.min(...scores)} – ${Math.max(...scores)}`
                : '—',
            submission_link: this.recipients.link(
              `/prototype/submissions/${this.pid(ctx)}/chair/review`,
            ),
          },
        });
      }
    }
    return emails;
  }

  /** The chair changed a review the reviewer had sent. */
  editedByChair(ctx: PaperContext, reviewer: Person): TemplateEmail {
    return {
      ...this.base(ctx),
      template: 'reviewEditedByChair',
      recipientType: 'Reviewer',
      to: reviewer,
      values: {
        first_name: firstName(reviewer.name, reviewer.email),
        paper_title: ctx.submission.title,
        submission_id: this.pid(ctx),
        submission_link: this.reviewerLink(ctx),
      },
    };
  }

  /**
   * The decision sent to the authors (their decision email, with the shared reviewer comments) and
   * the final decision to everyone who reviewed the paper. Nothing for an outcome without a
   * template (a stage).
   */
  async decision(
    executor: Executor,
    ctx: PaperContext,
    sent: {
      outcome: DecisionOutcome;
      label: string;
      note: string | null;
      changed: boolean;
      shared: readonly ReviewRow[];
      reviewers: readonly Person[];
      cameraReadyDeadline: Date | null;
      notificationDate: string | null;
    },
  ): Promise<TemplateEmail[]> {
    const template = sent.changed
      ? 'decisionChanged'
      : DECISION_TEMPLATES[sent.outcome];
    if (!template) {
      return [];
    }
    const details = ctx.submission.details as Record<string, unknown>;
    const presentation =
      typeof details.presentationType === 'string'
        ? details.presentationType
        : 'Paper Presentation';
    const note = sent.note?.trim() ?? '';
    const comments = sent.shared.filter((r) => r.commentsToAuthor);
    const values = {
      paper_title: ctx.submission.title,
      decision: sent.label,
      new_decision: sent.label,
      reason: note ? multiline(note) : '—',
      // "accepted … as a {{presentation_type}} presentation": "Poster", not "Poster Presentation".
      presentation_type:
        presentation.replace(/\s*presentation$/i, '') || 'Paper',
      chair_note: note
        ? `<b>A note from the programme chair</b><br>${multiline(note)}<br><br>`
        : '',
      reviews_for_author: comments
        .map(
          (r, i) => `Reviewer ${i + 1}: ${multiline(r.commentsToAuthor ?? '')}`,
        )
        .join('<br>'),
      registration_deadline: 'the registration deadline on the conference page',
      camera_ready_deadline:
        emailDate(sent.cameraReadyDeadline) ||
        'the date shown on the conference page',
      revision_deadline: 'the date shown on your submission page',
      final_decision_date:
        emailDate(sent.notificationDate) || 'the final decision date',
      upload_link: this.recipients.link(
        `/prototype/submissions/${this.pid(ctx)}/author`,
      ),
    };
    const authors = (await this.paperEmails.authorUpdates(executor, ctx)).map(
      (a): TemplateEmail => ({
        ...this.base(ctx),
        template,
        recipientType: 'Author',
        to: a,
        values: { ...values, first_name: firstName(a.name, a.email) },
      }),
    );
    const reviewers = sent.reviewers.map((p): TemplateEmail => ({
      ...this.base(ctx),
      template: 'finalDecisionReviewers',
      recipientType: 'Reviewer',
      to: p,
      values: {
        first_name: firstName(p.name, p.email),
        paper_title: ctx.submission.title,
        decision: sent.label,
      },
    }));
    return [...authors, ...reviewers];
  }
}
