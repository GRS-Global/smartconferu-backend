import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamptz, updatedAt } from './columns.js';
import { conferences, decisionTypes, tracks } from './conferences.js';
import {
  attendanceMode,
  decisionOutcome,
  fileKind,
  paymentStatus,
  submissionStatus,
} from './enums.js';
import { users } from './identity.js';

export const submissions = pgTable(
  'submissions',
  {
    id: uuid().primaryKey().defaultRandom(),
    conferenceId: uuid('conference_id')
      .notNull()
      .references(() => conferences.id, { onDelete: 'cascade' }),
    /** Sequential per conference; shown with the conference acronym as the paper id. */
    paperNo: integer('paper_no').notNull(),
    trackId: uuid('track_id').references(() => tracks.id, {
      onDelete: 'set null',
    }),
    submitterId: uuid('submitter_id')
      .notNull()
      .references(() => users.id),
    title: text().notNull(),
    abstract: text().notNull().default(''),
    keywords: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    details: jsonb().notNull().default({}),
    status: submissionStatus().notNull().default('submitted'),
    screening: jsonb().notNull().default({}),
    // The current decision. Authors only see it once notified (the notified_* columns).
    outcome: decisionOutcome().notNull().default('upload_pending'),
    decisionTypeId: uuid('decision_type_id').references(
      () => decisionTypes.id,
      { onDelete: 'set null' },
    ),
    decisionNote: text('decision_note'),
    deskRejected: boolean('desk_rejected').notNull().default(false),
    deskRejectReason: text('desk_reject_reason'),
    decidedAt: timestamptz('decided_at'),
    decidedBy: uuid('decided_by').references(() => users.id),
    notifiedOutcome: decisionOutcome('notified_outcome'),
    notifiedDecisionTypeId: uuid('notified_decision_type_id').references(
      () => decisionTypes.id,
      { onDelete: 'set null' },
    ),
    notifiedNote: text('notified_note'),
    notifiedAt: timestamptz('notified_at'),
    withdrawnAt: timestamptz('withdrawn_at'),
    withdrawnBy: text('withdrawn_by'),
    submittedAt: timestamptz('submitted_at').notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('submissions_conference_paper_no_key').on(t.conferenceId, t.paperNo),
    index('submissions_conference_idx').on(t.conferenceId),
    index('submissions_submitter_idx').on(t.submitterId),
    check(
      'submissions_withdrawn_by_check',
      sql`${t.withdrawnBy} in ('author', 'chair')`,
    ),
  ],
);

/**
 * The author list of a submission, in order. `user_id` is set when the author's email belongs to
 * an account (now or later), which is what gives co-authors access.
 */
export const submissionAuthors = pgTable(
  'submission_authors',
  {
    id: uuid().primaryKey().defaultRandom(),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    position: integer().notNull().default(0),
    userId: uuid('user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    name: text().notNull(),
    email: text().notNull(),
    /** The institution only (no department, city or country: those have their own fields). */
    affiliation: text(),
    department: text(),
    city: text(),
    country: text(),
    isCorresponding: boolean('is_corresponding').notNull().default(false),
  },
  (t) => [
    index('submission_authors_submission_idx').on(t.submissionId),
    index('submission_authors_user_idx').on(t.userId),
    index('submission_authors_email_idx').on(sql`lower(${t.email})`),
  ],
);

/**
 * An accepted paper's registration, recorded by hand by a chair: whether its fee is paid, whether
 * it is presented in person or online, and who presents it. One row per paper, created on the
 * first change; a paper without a row is "not paid", attendance not known yet. The presenter is
 * kept by email, so editing the author list never loses it.
 */
export const submissionRegistrations = pgTable('submission_registrations', {
  submissionId: uuid('submission_id')
    .primaryKey()
    .references(() => submissions.id, { onDelete: 'cascade' }),
  payment: paymentStatus().notNull().default('not_paid'),
  attendance: attendanceMode(),
  presenterEmail: text('presenter_email'),
  /** The chair's own note (receipt number, amount...). Never shown to authors. */
  note: text(),
  updatedBy: uuid('updated_by').references(() => users.id, {
    onDelete: 'set null',
  }),
  updatedAt: updatedAt(),
});

export const submissionFiles = pgTable(
  'submission_files',
  {
    id: uuid().primaryKey().defaultRandom(),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    kind: fileKind().notNull().default('paper'),
    version: integer().notNull().default(1),
    /** Object key in the papers bucket. */
    storagePath: text('storage_path').notNull(),
    fileName: text('file_name').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    uploadedAt: timestamptz('uploaded_at').notNull().defaultNow(),
    /** Result of the automatic checks run on upload (page count, format, …). */
    autoCheck: jsonb('auto_check'),
  },
  (t) => [
    unique('submission_files_storage_path_key').on(t.storagePath),
    index('submission_files_submission_idx').on(t.submissionId),
  ],
);
