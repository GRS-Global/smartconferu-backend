import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz } from './columns.js';
import { users } from './identity.js';

/**
 * "Verify my profile": a member asks the Super Admin to check that their profile is genuine
 * (My Profile). An approved request puts the green tick on the profile (it stays); a rejected
 * one carries the reason and the member may ask again. Only the server writes this, never the
 * profile JSON the member edits, so nobody can give themselves the tick.
 */
export const profileVerifications = pgTable(
  'profile_verifications',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text().notNull().default('pending'),
    /** What the member told the Super Admin ("Why should we verify you?"). */
    note: text(),
    /** The Super Admin's reason when rejected. */
    reason: text(),
    resolvedBy: uuid('resolved_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    resolvedAt: timestamptz('resolved_at'),
    createdAt: createdAt(),
  },
  (t) => [
    // One open request per member.
    uniqueIndex('profile_verifications_one_pending')
      .on(t.userId)
      .where(sql`${t.status} = 'pending'`),
    index('profile_verifications_status_idx').on(t.status, t.createdAt),
    check(
      'profile_verifications_status_check',
      sql`${t.status} in ('pending', 'approved', 'rejected', 'withdrawn')`,
    ),
  ],
);
