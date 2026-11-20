import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns.js';
import {
  cfpStatus,
  conferenceStatus,
  decisionOutcome,
  memberRole,
  memberStatus,
  reviewMode,
} from './enums.js';
import { users } from './identity.js';

export const conferences = pgTable(
  'conferences',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** URL id, e.g. "isbm2026". */
    slug: text().notNull(),
    /** "ISBM 2026-27"; also the paper-id prefix. */
    acronym: text().notNull(),
    title: text().notNull(),
    about: text(),
    mode: text(),
    venue: text(),
    city: text(),
    state: text(),
    country: text(),
    webPage: text('web_page'),
    contactEmail: text('contact_email'),
    primaryArea: text('primary_area'),
    secondaryArea: text('secondary_area'),
    startDate: date('start_date'),
    endDate: date('end_date'),
    submissionDeadline: timestamptz('submission_deadline'),
    reviewDeadline: timestamptz('review_deadline'),
    notificationDate: date('notification_date'),
    cameraReadyDeadline: timestamptz('camera_ready_deadline'),
    reviewMode: reviewMode('review_mode').notNull().default('double_blind'),
    logoPath: text('logo_path'),
    status: conferenceStatus().notNull().default('pending_approval'),
    adminNote: text('admin_note'),
    nextPaperNo: integer('next_paper_no').notNull().default(1),
    details: jsonb().notNull().default({}),
    settings: jsonb().notNull().default({}),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamptz('deleted_at'),
    /** Set while a Super Admin has suspended the conference: read-only for everyone else. */
    suspendedAt: timestamptz('suspended_at'),
  },
  (t) => [
    uniqueIndex('conferences_slug_key').on(t.slug),
    check('conferences_slug_check', sql`${t.slug} ~ '^[a-z0-9-]+$'`),
    check(
      'conferences_mode_check',
      sql`${t.mode} in ('in_person', 'virtual', 'hybrid')`,
    ),
    check(
      'conferences_dates_check',
      sql`${t.endDate} is null or ${t.startDate} is null or ${t.endDate} >= ${t.startDate}`,
    ),
  ],
);

export const tracks = pgTable(
  'tracks',
  {
    id: uuid().primaryKey().defaultRandom(),
    conferenceId: uuid('conference_id')
      .notNull()
      .references(() => conferences.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    description: text(),
    position: integer().notNull().default(0),
  },
  (t) => [index('tracks_conference_idx').on(t.conferenceId)],
);

/**
 * Who has which role on which conference. An invitation to someone without an account has only
 * `invited_email`; it is linked to the user when they sign up with that address.
 * Authors aren't listed here: authorship comes from submissions.
 */
export const conferenceMembers = pgTable(
  'conference_members',
  {
    id: uuid().primaryKey().defaultRandom(),
    conferenceId: uuid('conference_id')
      .notNull()
      .references(() => conferences.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    invitedEmail: text('invited_email'),
    displayName: text('display_name'),
    role: memberRole().notNull(),
    status: memberStatus().notNull().default('invited'),
    expertise: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    maxPapers: integer('max_papers'),
    invitedBy: uuid('invited_by').references(() => users.id),
    invitedAt: timestamptz('invited_at').notNull().defaultNow(),
    respondedAt: timestamptz('responded_at'),
    declineReason: text('decline_reason'),
  },
  (t) => [
    uniqueIndex('conference_members_user_role_key')
      .on(t.conferenceId, t.userId, t.role)
      .where(sql`${t.userId} is not null`),
    uniqueIndex('conference_members_email_role_key')
      .on(t.conferenceId, sql`lower(${t.invitedEmail})`, t.role)
      .where(sql`${t.userId} is null`),
    index('conference_members_user_idx').on(t.userId),
    check(
      'conference_members_who_check',
      sql`${t.userId} is not null or ${t.invitedEmail} is not null`,
    ),
  ],
);

/** The public call-for-papers page of a conference; one per conference. */
export const cfps = pgTable('cfps', {
  conferenceId: uuid('conference_id')
    .primaryKey()
    .references(() => conferences.id, { onDelete: 'cascade' }),
  content: jsonb().notNull().default({}),
  theme: jsonb().notNull().default({}),
  status: cfpStatus().notNull().default('draft'),
  submittedAt: timestamptz('submitted_at'),
  decidedAt: timestamptz('decided_at'),
  adminNote: text('admin_note'),
  updatedAt: updatedAt(),
});

/** The decision labels a conference uses, each mapped to a fixed outcome. */
export const decisionTypes = pgTable(
  'decision_types',
  {
    id: uuid().primaryKey().defaultRandom(),
    conferenceId: uuid('conference_id')
      .notNull()
      .references(() => conferences.id, { onDelete: 'cascade' }),
    label: text().notNull(),
    color: text().notNull().default('#64748B'),
    outcome: decisionOutcome().notNull(),
    description: text(),
    position: integer().notNull().default(0),
  },
  (t) => [index('decision_types_conference_idx').on(t.conferenceId)],
);

export const conferenceDeletionRequests = pgTable(
  'conference_deletion_requests',
  {
    id: uuid().primaryKey().defaultRandom(),
    conferenceId: uuid('conference_id')
      .notNull()
      .references(() => conferences.id, { onDelete: 'cascade' }),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    reason: text().notNull(),
    status: text().notNull().default('pending'),
    adminNote: text('admin_note'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamptz('decided_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('conference_deletion_one_open')
      .on(t.conferenceId)
      .where(sql`${t.status} = 'pending'`),
    check(
      'conference_deletion_requests_status_check',
      sql`${t.status} in ('pending', 'approved', 'rejected', 'cancelled')`,
    ),
  ],
);

/**
 * A chair's "Request extension" of the conference's license date (Conference Details › License
 * expiry). A Super Admin approves (the license then runs until `new_expiry`, kept in
 * conferences.details.licenseExpiry) or declines; the chair can withdraw a request that waits.
 */
export const licenseRequests = pgTable(
  'license_requests',
  {
    id: uuid().primaryKey().defaultRandom(),
    conferenceId: uuid('conference_id')
      .notNull()
      .references(() => conferences.id, { onDelete: 'cascade' }),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    requestedDate: date('requested_date', { mode: 'string' }).notNull(),
    reason: text(),
    status: text().notNull().default('pending'),
    decisionReason: text('decision_reason'),
    newExpiry: date('new_expiry', { mode: 'string' }),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamptz('decided_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('license_requests_conference_idx').on(t.conferenceId, t.createdAt),
    uniqueIndex('license_requests_one_open')
      .on(t.conferenceId)
      .where(sql`${t.status} = 'pending'`),
    check(
      'license_requests_status_check',
      sql`${t.status} in ('pending', 'approved', 'declined', 'withdrawn')`,
    ),
  ],
);
