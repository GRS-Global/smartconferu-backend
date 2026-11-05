import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

export const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);

/**
 * An in-process Postgres (PGlite) with every migration from drizzle/ applied. Used by the e2e
 * tests and `npm run db:serve`, so neither needs Docker.
 *
 * Pass `dataDir` to keep the database on disk; omit it for a throwaway in-memory one.
 */
export async function createLocalDb(dataDir?: string): Promise<PGlite> {
  const db = await PGlite.create({ dataDir, extensions: { vector } });
  await migrate(drizzle({ client: db }), { migrationsFolder: MIGRATIONS_DIR });
  return db;
}
