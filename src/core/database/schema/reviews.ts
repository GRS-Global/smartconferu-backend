import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns.js';
import { conferenceMembers, decisionTypes } from './conferences.js';
import { assignmentStatus, decisionOutcome, reviewStatus } from './enums.js';
import { users } from './identity.js';
import { submissions } from './submissions.js';

export const reviewAssignments = pgTable(
  'review_assignments',
  {
    id: uuid().primaryKey().defaultRandom(),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    reviewerId: uuid('reviewer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: assignmentStatus().notNull().default('assigned'),
    dueAt: timestamptz('due_at'),
    assignedBy: uuid('assigned_by').references(() => users.id),
    assignedAt: timestamptz('assigned_at').notNull().defaultNow(),
    respondedAt: timestamptz('responded_at'),
    declineReason: text('decline_reason'),
  },
  (t) => [
    unique('review_assignments_submission_reviewer_key').on(
      t.submissionId,
      t.reviewerId,
    ),
    index('review_assignments_reviewer_idx').on(t.reviewerId),
  ],
);

/**
 * Papers assigned to an invited reviewer who hasn't accepted yet (or has no account yet). They
 * become review_assignments when the invitation is accepted.
 */
export const pendingReviewAssignments = pgTable(
  'pending_review_assignments',
  {
    id: uuid().primaryKey().defaultRandom(),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => conferenceMembers.id, { onDelete: 'cascade' }),
    dueAt: timestamptz('due_at'),
    assignedBy: uuid('assigned_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('pending_review_assignments_submission_member_key').on(
      t.submissionId,
      t.memberId,
    ),
    index('pending_review_assignments_member_idx').on(t.memberId),
  ],
);

export const reviews = pgTable(
  'reviews',
  {
    id: uuid().primaryKey().defaultRandom(),
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => reviewAssignments.id, { onDelete: 'cascade' }),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    reviewerId: uuid('reviewer_id')
      .notNull()
      .references(() => users.id),
    score: smallint(),
    confidence: text(),
    recommendation: text(),
    commentsToAuthor: text('comments_to_author'),
    commentsToChair: text('comments_to_chair'),
    /** Answers to the conference's own review form questions. */
    answers: jsonb().notNull().default({}),
    sharedWithAuthor: boolean('shared_with_author').notNull().default(false),
    status: reviewStatus().notNull().default('draft'),
    submittedAt: timestamptz('submitted_at'),
    editedByChairAt: timestamptz('edited_by_chair_at'),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('reviews_assignment_key').on(t.assignmentId),
    index('reviews_submission_idx').on(t.submissionId),
    check('reviews_score_check', sql`${t.score} between 1 and 5`),
    check(
      'reviews_confidence_check',
      sql`${t.confidence} in ('low', 'medium', 'high')`,
    ),
    check(
      'reviews_recommendation_check',
      sql`${t.recommendation} in ('accept', 'revise', 'reject')`,
    ),
  ],
);

/** Every decision ever recorded on a submission, newest last. */
export const decisionEvents = pgTable(
  'decision_events',
  {
    id: uuid().primaryKey().defaultRandom(),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    outcome: decisionOutcome().notNull(),
    decisionTypeId: uuid('decision_type_id').references(
      () => decisionTypes.id,
      { onDelete: 'set null' },
    ),
    note: text(),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamptz('decided_at').notNull().defaultNow(),
  },
  (t) => [index('decision_events_submission_idx').on(t.submissionId)],
);
