import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns.js';
import { conferences } from './conferences.js';
import { users } from './identity.js';
import { submissions } from './submissions.js';

/** In-app notifications (the bell). */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conferenceId: uuid('conference_id').references(() => conferences.id, {
      onDelete: 'cascade',
    }),
    submissionId: uuid('submission_id').references(() => submissions.id, {
      onDelete: 'cascade',
    }),
    kind: text().notNull(),
    title: text().notNull(),
    body: text(),
    link: text(),
    readAt: timestamptz('read_at'),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.createdAt.desc())],
);

/** Platform default email templates; each conference gets its own copy when approved. */
export const emailTemplates = pgTable('email_templates', {
  key: text().primaryKey(),
  module: text(),
  role: text(),
  label: text().notNull(),
  sendType: text('send_type'),
  triggerText: text('trigger_text'),
  recipients: text(),
  subject: text().notNull(),
  body: text().notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, {
    onDelete: 'set null',
  }),
  updatedAt: updatedAt(),
});

export const conferenceEmailTemplates = pgTable(
  'conference_email_templates',
  {
    conferenceId: uuid('conference_id')
      .notNull()
      .references(() => conferences.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    label: text(),
    enabled: boolean().notNull().default(true),
    subject: text().notNull().default(''),
    body: text().notNull().default(''),
    /** A template the conference added itself, not a copy of a platform default. */
    isCustom: boolean('is_custom').notNull().default(false),
    updatedBy: uuid('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.conferenceId, t.key] })],
);

/**
 * Every email the platform sends, and the queue they are sent from. A change and its emails are
 * written in one transaction (status `queued`); the email worker sends them (`sending` → `sent`, or
 * back to `queued` with a later `next_attempt_at` until the attempts run out → `failed`). The chairs
 * read their conference's rows as Email Logs.
 */
export const emailLog = pgTable(
  'email_log',
  {
    id: uuid().primaryKey().defaultRandom(),
    conferenceId: uuid('conference_id').references(() => conferences.id, {
      onDelete: 'cascade',
    }),
    submissionId: uuid('submission_id').references(() => submissions.id, {
      onDelete: 'set null',
    }),
    event: text().notNull(),
    templateKey: text('template_key').notNull(),
    templateLabel: text('template_label'),
    toEmail: text('to_email').notNull(),
    toName: text('to_name'),
    recipientType: text('recipient_type'),
    subject: text().notNull(),
    /** The message as the template produced it (shown in Email Logs). */
    body: text(),
    /** What is sent: the body in the platform frame, and its plain-text version. */
    html: text(),
    text: text(),
    replyTo: text('reply_to'),
    status: text().notNull().default('queued'),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at').defaultNow(),
    providerId: text('provider_id'),
    error: text(),
    sentAt: timestamptz('sent_at'),
    sentBy: uuid('sent_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('email_log_conference_idx').on(t.conferenceId, t.createdAt.desc()),
    index('email_log_queue_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'queued'`),
    check(
      'email_log_status_check',
      sql`${t.status} in ('queued', 'sending', 'sent', 'failed')`,
    ),
  ],
);
