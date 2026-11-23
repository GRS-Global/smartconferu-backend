import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns.js';
import { users } from './identity.js';

/**
 * Master data the Super Admin keeps (admin › Master data): the lists members pick from. Until now
 * these were fixed lists in the app (src/shared/societies.js, institutions.js, researchAreas.js);
 * migration 0007 copies them in. Nothing is ever deleted: an entry is deactivated (societies) or
 * retired (institutions, research areas), so records that already name it keep working.
 */

/** Professional societies a member can list under My Profile › Memberships. */
export const societies = pgTable(
  'societies',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Stable short id (the app's logo files are named after it), e.g. "ieee-cs". */
    key: text().notNull(),
    name: text().notNull(),
    acronym: text().notNull(),
    url: text(),
    status: text().notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    updatedBy: uuid('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    uniqueIndex('societies_key_unique').on(t.key),
    uniqueIndex('societies_acronym_unique').on(sql`lower(${t.acronym})`),
    check('societies_status_check', sql`${t.status} in ('active', 'inactive')`),
  ],
);

/** Approved institution names: what the institution search offers (profile, invitations). */
export const institutions = pgTable(
  'institutions',
  {
    id: uuid().primaryKey().defaultRandom(),
    key: text().notNull(),
    name: text().notNull(),
    /** Short forms people type ("IIT Bombay", "IITB"); a search for any of them finds it. */
    aliases: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    country: text(),
    departments: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text().notNull().default('active'),
    /** Set when retired by merging into another institution. */
    mergedIntoId: uuid('merged_into_id').references(
      (): AnyPgColumn => institutions.id,
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    updatedBy: uuid('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    uniqueIndex('institutions_key_unique').on(t.key),
    uniqueIndex('institutions_name_unique').on(sql`lower(${t.name})`),
    check(
      'institutions_status_check',
      sql`${t.status} in ('active', 'retired')`,
    ),
  ],
);

/**
 * The research-area taxonomy: primary areas (no parent; `groupLabel` places them under a heading
 * such as "Natural Sciences") and their secondary areas (parent = the primary). Conferences store
 * the pair as text (conferences.primary_area / secondary_area), so a rename updates them too.
 */
export const researchAreas = pgTable(
  'research_areas',
  {
    id: uuid().primaryKey().defaultRandom(),
    parentId: uuid('parent_id').references((): AnyPgColumn => researchAreas.id),
    groupLabel: text('group_label'),
    name: text().notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    status: text().notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    updatedBy: uuid('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    index('research_areas_parent_idx').on(t.parentId),
    // Unique per level: primaries among primaries, secondaries within their primary.
    uniqueIndex('research_areas_name_unique').on(
      sql`coalesce(${t.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`lower(${t.name})`,
    ),
    check(
      'research_areas_status_check',
      sql`${t.status} in ('active', 'retired')`,
    ),
    check(
      'research_areas_level_check',
      sql`(${t.parentId} is null) = (${t.groupLabel} is not null)`,
    ),
  ],
);

/**
 * Names members typed that are not on the lists yet (a new institution under My Profile ›
 * Affiliation, a new society under Memberships). The member can use it straight away ("Pending
 * review"); the Super Admin approves it into the master data, or rejects it. One row per person
 * and name; the console shows people who typed the same name as one item.
 */
export const profileRequests = pgTable(
  'profile_requests',
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: text().notNull(),
    /** The name as typed. */
    name: text().notNull(),
    /** Lower-case letters and digits only: the same name typed twice is one item. */
    nameKey: text('name_key').notNull(),
    /** A secondary research area: the primary area it was typed under. */
    parentName: text('parent_name'),
    /** A society's website (the admin checks it before approving). */
    url: text(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text().notNull().default('pending'),
    /** What the name became (approved: the list entry's name) . */
    resolvedName: text('resolved_name'),
    /** The list entry it was approved into or mapped to (institutions.id / societies.id). */
    resolvedId: uuid('resolved_id'),
    reason: text(),
    resolvedBy: uuid('resolved_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    resolvedAt: timestamptz('resolved_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('profile_requests_unique').on(t.kind, t.nameKey, t.userId),
    index('profile_requests_status_idx').on(t.status, t.createdAt),
    check(
      'profile_requests_kind_check',
      sql`${t.kind} in ('institution', 'society', 'research_area')`,
    ),
    check(
      'profile_requests_status_check',
      sql`${t.status} in ('pending', 'approved', 'rejected')`,
    ),
  ],
);
