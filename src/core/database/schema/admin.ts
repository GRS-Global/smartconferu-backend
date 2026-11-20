import { index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { check } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz } from './columns.js';
import { users } from './identity.js';

/**
 * The admin console's approval queues (`requests`, `deletions`, `licenses`, `cfps`) keep two kinds
 * of working notes about an item, keyed by the queue and the item's id:
 * - a claim ("Assign to me"), so two admins don't work the same item; one per item;
 * - notes: internal ones only admins see, and messages sent to the person who asked
 *   ("Ask for info"), kept here as the item's thread.
 */
export const adminClaims = pgTable(
  'admin_claims',
  {
    queue: text().notNull(),
    itemId: text('item_id').notNull(),
    adminId: uuid('admin_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    claimedAt: timestamptz('claimed_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.queue, t.itemId] }),
    index('admin_claims_admin_idx').on(t.adminId),
  ],
);

export const adminNotes = pgTable(
  'admin_notes',
  {
    id: uuid().primaryKey().defaultRandom(),
    queue: text().notNull(),
    itemId: text('item_id').notNull(),
    /** `note`: only admins see it. `message`: sent to the person who asked. */
    kind: text().notNull().default('note'),
    authorId: uuid('author_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    text: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('admin_notes_item_idx').on(t.queue, t.itemId, t.createdAt),
    check('admin_notes_kind_check', sql`${t.kind} in ('note', 'message')`),
  ],
);
