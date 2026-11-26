import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { conferences } from './conferences.js';
import { createdAt, timestamptz, updatedAt } from './columns.js';
import { users } from './identity.js';

/** A certificate's artwork and wording: made once per conference, reused by any number of sends. `design` is the editor's JSON document. */
export const certificateDesigns = pgTable(
  'certificate_designs',
  {
    id: uuid().primaryKey().defaultRandom(),
    conferenceId: uuid('conference_id')
      .notNull()
      .references(() => conferences.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    typeKey: text('type_key').notNull(),
    design: jsonb().notNull(),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('certificate_designs_conference_idx').on(t.conferenceId)],
);

/** One send: points at a design, carries the audience rule and the covering email; once issued it holds the certificates. */
export const certificateDistributions = pgTable(
  'certificate_distributions',
  {
    id: uuid().primaryKey().defaultRandom(),
    conferenceId: uuid('conference_id')
      .notNull()
      .references(() => conferences.id, { onDelete: 'cascade' }),
    designId: uuid('design_id')
      .notNull()
      .references(() => certificateDesigns.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    audience: jsonb().notNull(),
    email: jsonb().notNull(),
    manual: jsonb().notNull().default([]),
    overrides: jsonb().notNull().default({}),
    status: text().notNull().default('draft'),
    sentAt: timestamptz('sent_at'),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('certificate_distributions_conference_idx').on(t.conferenceId),
    index('certificate_distributions_design_idx').on(t.designId),
    check(
      'certificate_distributions_status_check',
      sql`${t.status} in ('draft', 'sent')`,
    ),
  ],
);

/** A certificate that was issued to one person. `serial` is the public ID printed on it and in its QR code. */
export const issuedCertificates = pgTable(
  'issued_certificates',
  {
    id: uuid().primaryKey().defaultRandom(),
    conferenceId: uuid('conference_id')
      .notNull()
      .references(() => conferences.id, { onDelete: 'cascade' }),
    distributionId: uuid('distribution_id')
      .notNull()
      .references(() => certificateDistributions.id, { onDelete: 'cascade' }),
    serial: text().notNull(),
    name: text().notNull(),
    email: text().notNull().default(''),
    affiliation: text().notNull().default(''),
    roleLabel: text('role_label').notNull().default(''),
    paperLabel: text('paper_label').notNull().default(''),
    paperTitle: text('paper_title').notNull().default(''),
    issuedAt: timestamptz('issued_at').defaultNow().notNull(),
    status: text().notNull().default('sent'),
    bounceReason: text('bounce_reason'),
    opened: boolean().notNull().default(false),
    downloaded: boolean().notNull().default(false),
    verifiedCount: integer('verified_count').notNull().default(0),
    /** Withdrawn by a chair: the public check then says so. `revokedBy` keeps who did it; `replacedBy` is the serial of the corrected certificate. */
    revokedAt: timestamptz('revoked_at'),
    revokeReason: text('revoke_reason'),
    revokedBy: uuid('revoked_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    replacedBy: text('replaced_by'),
    /** The last time the email was sent again by hand. */
    resentAt: timestamptz('resent_at'),
  },
  (t) => [
    uniqueIndex('issued_certificates_serial_unique').on(t.serial),
    index('issued_certificates_conference_idx').on(t.conferenceId),
    index('issued_certificates_distribution_idx').on(t.distributionId),
    index('issued_certificates_email_idx').on(sql`lower(${t.email})`),
    check(
      'issued_certificates_status_check',
      sql`${t.status} in ('sent', 'bounced')`,
    ),
  ],
);

/**
 * The signature library of a conference: a signatory's signature image plus who they are. The image itself is
 * in file storage (`storagePath`), never in this table.
 */
export const certificateSignatures = pgTable(
  'certificate_signatures',
  {
    id: uuid().primaryKey().defaultRandom(),
    conferenceId: uuid('conference_id')
      .notNull()
      .references(() => conferences.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    designation: text().notNull().default(''),
    institution: text().notNull().default(''),
    storagePath: text('storage_path').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('certificate_signatures_conference_idx').on(t.conferenceId),
    // At most one default signature per conference.
    uniqueIndex('certificate_signatures_one_default')
      .on(t.conferenceId)
      .where(sql`${t.isDefault}`),
  ],
);

/**
 * The pictures of a conference's certificates (logos, backgrounds, graphics): uploaded once, used by any number of designs, which refer to
 * one as `asset:<id>`. The picture is in file storage (`storagePath`), never in this table or inside a design's JSON.
 */
export const certificateAssets = pgTable(
  'certificate_assets',
  {
    id: uuid().primaryKey().defaultRandom(),
    conferenceId: uuid('conference_id')
      .notNull()
      .references(() => conferences.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    storagePath: text('storage_path').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('certificate_assets_conference_idx').on(t.conferenceId)],
);
