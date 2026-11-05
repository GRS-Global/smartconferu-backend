import { defineConfig } from 'drizzle-kit';

// The schema in src/core/database/schema/ is the source of truth. `npm run db:generate` diffs it
// against the last migration and writes the next one into drizzle/; `npm run db:migrate` applies
// pending migrations to DATABASE_URL.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/core/database/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
  verbose: true,
});
