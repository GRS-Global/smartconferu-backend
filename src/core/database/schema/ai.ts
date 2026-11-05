import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  unique,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from './columns.js';
import { conferences } from './conferences.js';
import { users } from './identity.js';
import { submissionFiles, submissions } from './submissions.js';

/**
 * A paper split into passages with an embedding each, so AI features send only the relevant parts.
 * Searched exactly (no approximate index): a search is limited to one paper's few hundred chunks.
 */
export const paperChunks = pgTable(
  'paper_chunks',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id').references(() => submissionFiles.id, {
      onDelete: 'cascade',
    }),
    chunkIndex: integer('chunk_index').notNull(),
    section: text(),
    content: text().notNull(),
    tokenCount: integer('token_count'),
    embedding: vector({ dimensions: 1024 }).notNull(),
    embeddingModel: text('embedding_model').notNull().default('voyage-3.5'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('paper_chunks_submission_chunk_key').on(
      t.submissionId,
      t.chunkIndex,
    ),
  ],
);

/** A short AI summary of each paper, reused across features. */
export const paperDigests = pgTable('paper_digests', {
  submissionId: uuid('submission_id')
    .primaryKey()
    .references(() => submissions.id, { onDelete: 'cascade' }),
  fileId: uuid('file_id').references(() => submissionFiles.id, {
    onDelete: 'set null',
  }),
  summary: text().notNull(),
  keyPoints: jsonb('key_points').notNull().default({}),
  model: text().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** One row per AI call, for cost reporting per conference and user. */
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    conferenceId: uuid('conference_id').references(() => conferences.id, {
      onDelete: 'cascade',
    }),
    submissionId: uuid('submission_id').references(() => submissions.id, {
      onDelete: 'set null',
    }),
    feature: text().notNull(),
    provider: text().notNull().default('anthropic'),
    model: text().notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    status: text().notNull().default('ok'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ai_usage_user_idx').on(t.userId, t.createdAt.desc()),
    index('ai_usage_conference_idx').on(t.conferenceId, t.createdAt.desc()),
    check(
      'ai_usage_provider_check',
      sql`${t.provider} in ('anthropic', 'voyage')`,
    ),
    check('ai_usage_status_check', sql`${t.status} in ('ok', 'error')`),
  ],
);
