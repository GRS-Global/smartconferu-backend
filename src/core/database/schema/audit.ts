import { bigint, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './columns.js';
import { users } from './identity.js';

/**
 * Append-only record of security-relevant and sensitive actions: sign-ins, password and email
 * changes, role changes, decisions, deletions. Never updated or deleted by the app.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
    /** Null for actions without a signed-in user (e.g. a failed sign-in). */
    actorId: uuid('actor_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Dotted verb, e.g. "auth.sign_in", "submission.decision_recorded". */
    action: text().notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    data: jsonb().notNull().default({}),
  },
  (t) => [
    index('audit_log_entity_idx').on(t.entityType, t.entityId),
    index('audit_log_actor_idx').on(t.actorId, t.occurredAt.desc()),
  ],
);
