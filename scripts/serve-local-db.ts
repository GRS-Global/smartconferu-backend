/**
 * A local Postgres for running the API without Docker: every migration applied, plus a demo
 * account, served on 127.0.0.1:54329. Data is kept in .pglite-dev/ between runs; pass --fresh
 * (or delete the folder) to start over.
 *
 *   npm run db:serve     then in .env: DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres
 *
 * Sign in as dev@example.test / smartconferu-dev (a super admin) through POST /api/v1/auth/sign-in.
 */
import { rmSync } from 'node:fs';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { hash } from '@node-rs/argon2';
import { createLocalDb } from '../test/db/local-db.ts';

const DATA_DIR = './.pglite-dev';
const PORT = Number(process.env.LOCAL_DB_PORT ?? 54329);
const DEMO = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'dev@example.test',
  password: 'smartconferu-dev',
};

if (process.argv.includes('--fresh')) {
  rmSync(DATA_DIR, { recursive: true, force: true });
}
const db = await createLocalDb(DATA_DIR);

const { rows } = await db.query('select 1 from users where id = $1', [DEMO.id]);
if (rows.length === 0) {
  await db.transaction(async (tx) => {
    await tx.query(
      `insert into users (id, email, password_hash, email_verified_at, is_super_admin)
       values ($1, $2, $3, now(), true)`,
      [DEMO.id, DEMO.email, await hash(DEMO.password)],
    );
    await tx.query(
      `insert into profiles (id, first_name, last_name) values ($1, 'Dev', 'User')`,
      [DEMO.id],
    );
    await tx.query('insert into profile_details (user_id) values ($1)', [
      DEMO.id,
    ]);
  });
}

// Several clients at once (the API plus pgAdmin or psql). They share one database session, so
// this is for local development only.
const server = new PGLiteSocketServer({
  db,
  port: PORT,
  host: '127.0.0.1',
  maxConnections: 20,
});
await server.start();
console.log(
  `Local database ready: DATABASE_URL=postgres://postgres@127.0.0.1:${PORT}/postgres\n` +
    `Demo account: ${DEMO.email} / ${DEMO.password}`,
);

const shutdown = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
