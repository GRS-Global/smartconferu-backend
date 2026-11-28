import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createLocalDb } from '../db/local-db.js';
import { FakeOidcProvider } from './fake-oidc.js';

export const APP_URL = 'http://app.test';
export const APP_ORIGIN = 'http://app.test';
export const API_URL = 'http://api.test';

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

export interface TestApp {
  app: NestExpressApplication;
  /** The database itself, as superuser: for arranging and inspecting test data. */
  db: PGlite;
  /** Plays Google, Microsoft and ORCID. */
  oidc: FakeOidcProvider;
  /** Emails "sent" so far (EMAIL_TRANSPORT=log). */
  outbox(): {
    to: string;
    subject: string;
    text: string;
    html: string;
    attachments?: { filename: string; content: Buffer }[];
  }[];
  /** Sends the email queue now (the background worker is off in tests); emails land in outbox(). */
  sendQueuedEmails(): Promise<{ sent: number; failed: number }>;
  /** Runs the background jobs now (they are off in tests), as of `now`. */
  runJobs(
    now?: Date,
  ): Promise<import('../../src/modules/jobs/jobs.runner.js').JobsResult>;
  /** A valid access token for `userId`, as the API would issue it at sign-in. */
  tokenFor(userId: string, mfa?: boolean): Promise<string>;
  /**
   * A verified session that just passed "Confirm it's you" (high-risk admin actions): a real
   * session row with a fresh step-up, and its access token.
   */
  steppedUpToken(userId: string): Promise<string>;
  /** Creates an account through the app's own repository (verified unless told otherwise). */
  createUser(fields?: {
    email?: string;
    password?: string;
    verified?: boolean;
    firstName?: string;
    lastName?: string;
  }): Promise<TestUser>;
  /** Deletes all users, conferences, tokens and the audit log, and empties the outbox. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The real app (same module graph, same setupApp) against a fresh local Postgres with every
 * migration applied, reached through the production driver (postgres.js) over a socket.
 */
export async function createTestApp(
  /** Settings that differ from the test defaults (e.g. AI keys pointing at a fake server). */
  overrides: Record<string, string> = {},
): Promise<TestApp> {
  const db = await createLocalDb();
  const port = await freePort();
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();

  const storageDir = mkdtempSync(join(tmpdir(), 'sc-files-'));
  const oidc = new FakeOidcProvider();
  await oidc.start();

  const { privateKey } = generateKeyPairSync('ed25519');
  Object.assign(process.env, {
    API_URL,
    // A developer's .env may hold the testing switch that stops emails to authors / reviewers; the tests send to everyone.
    EMAIL_ONLY_TO_ROLES: '',
    // The approval flow is the default under test; the auto-approve default is tested on its own.
    CFP_AUTO_APPROVE: 'false',
    ALLOW_PAST_CONFERENCE_DATES: 'false',
    MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    GOOGLE_ISSUER: oidc.issuer('google'),
    MICROSOFT_CLIENT_ID: 'microsoft-client',
    MICROSOFT_CLIENT_SECRET: 'microsoft-secret',
    MICROSOFT_ISSUER: oidc.issuer('microsoft'),
    ORCID_CLIENT_ID: 'orcid-client',
    ORCID_CLIENT_SECRET: 'orcid-secret',
    ORCID_ISSUER: oidc.issuer('orcid'),
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    // PGlite is a single session: one connection keeps transactions from interleaving.
    DATABASE_POOL_MAX: '1',
    APP_URL,
    CORS_ORIGINS: APP_ORIGIN,
    JWT_PRIVATE_KEY: privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
    TOKEN_HASH_SECRET: randomBytes(32).toString('hex'),
    EMAIL_TRANSPORT: 'log',
    // A developer's .env may turn this on; tests opt in (dev-codes.e2e-spec.ts).
    DEV_SHOW_EMAIL_CODES: 'false',
    // Tests send the queue themselves (sendQueuedEmails), so nothing is sent behind their back.
    EMAIL_QUEUE_ENABLED: 'false',
    // Tests run the jobs themselves (runJobs).
    JOBS_ENABLED: 'false',
    // No AI keys: the AI tests point them at a fake server themselves.
    ANTHROPIC_API_KEY: '',
    VOYAGE_API_KEY: '',
    AI_AUTO_INGEST: 'false',
    // PGlite's socket server doesn't relay LISTEN/NOTIFY (fan-out is unit tested).
    REALTIME_FANOUT: 'false',
    // Always a temporary folder: a developer's .env may point at a real bucket.
    FILE_STORAGE_DRIVER: 'local',
    FILE_STORAGE_DIR: storageDir,
    SWAGGER_ENABLED: 'false',
    // Tests send many auth requests from one address; rate limits are not what they test.
    RATE_LIMIT_ENABLED: 'false',
    ...overrides,
  });

  // Imported only now: ConfigModule reads and validates process.env when app.module loads.
  const { AppModule } = await import('../../src/app.module.js');
  const { setupApp } = await import('../../src/setup-app.js');
  const { AccessTokenService } =
    await import('../../src/core/auth/access-token.service.js');
  const { PasswordService } =
    await import('../../src/core/auth/password.service.js');
  const { EmailTransport, LogTransport } =
    await import('../../src/core/email/email.transport.js');
  const { EmailWorker } =
    await import('../../src/core/email/email-worker.service.js');
  const { JobsRunner } = await import('../../src/modules/jobs/jobs.runner.js');
  const { AuthRepository } =
    await import('../../src/modules/auth/auth.repository.js');
  const { DatabaseService } =
    await import('../../src/core/database/database.service.js');

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: false,
  });
  setupApp(app);
  await app.init();

  const transport = app.get(EmailTransport);
  if (!(transport instanceof LogTransport)) {
    throw new Error('Expected the log email transport');
  }
  const passwords = app.get(PasswordService);
  const accounts = app.get(AuthRepository);
  const database = app.get(DatabaseService);

  return {
    app,
    db,
    outbox: () => transport.outbox,
    sendQueuedEmails: () => app.get(EmailWorker).drain(),
    runJobs: (now) => app.get(JobsRunner).runAll(now),
    oidc,
    tokenFor: (userId, mfa = false) =>
      app.get(AccessTokenService).issue(userId, randomUUID(), mfa),
    async steppedUpToken(userId) {
      const familyId = randomUUID();
      await db.query(
        `insert into sessions (user_id, family_id, token_hash, expires_at, mfa_verified_at, step_up_at)
         values ($1, $2, $3, now() + interval '1 day', now(), now())`,
        [userId, familyId, randomUUID()],
      );
      return app.get(AccessTokenService).issue(userId, familyId, true);
    },
    async createUser({
      // Every test user gets an institution of their own, so two of them never clash as "same institution" (reviewer conflicts).
      email = `${randomUUID()}@u${randomUUID().slice(0, 8)}.example.test`,
      password = 'correct horse battery',
      verified = true,
      firstName = 'Test',
      lastName = 'User',
    } = {}) {
      const passwordHash = await passwords.hash(password);
      const user = await database.transaction((tx) =>
        accounts.create(
          { email, passwordHash, emailVerified: verified, firstName, lastName },
          tx,
        ),
      );
      return { id: user.id, email: user.email ?? email, password };
    },
    async reset() {
      await db.exec(
        'delete from email_log; delete from admin_notes; delete from admin_claims; delete from conferences; delete from users; delete from audit_log; delete from auth_tokens;',
      );
      transport.outbox.length = 0;
    },
    async close() {
      await app.close();
      await server.stop();
      await oidc.stop();
      await db.close();
      rmSync(storageDir, { recursive: true, force: true });
    },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('No port')),
      );
    });
  });
}

/** The `token` query parameter of the first link in an email. */
export function linkToken(text: string): string {
  const match = /token=([\w%-]+)/.exec(text);
  if (!match) throw new Error(`No link in email:\n${text}`);
  return decodeURIComponent(match[1]);
}

/** The 6-digit code in an email. */
export function emailCode(text: string): string {
  const match = /\b(\d{6})\b/.exec(text);
  if (!match) throw new Error(`No code in email:\n${text}`);
  return match[1];
}

/** The refresh cookie set by a response, as a `Cookie` header value. */
export function refreshCookie(
  setCookie: string[] | string | undefined,
): string {
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie
      ? [setCookie]
      : [];
  const found = cookies.find(
    (c) => c.startsWith('sc_refresh=') && !c.startsWith('sc_refresh=;'),
  );
  if (!found) throw new Error(`No refresh cookie in: ${cookies.join(' | ')}`);
  return found.split(';')[0];
}

/** A cookie set by a response, as a `Cookie` header value (`name=value`); undefined if absent or cleared. */
export function cookieFrom(
  setCookie: string[] | string | undefined,
  name: string,
): string | undefined {
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie
      ? [setCookie]
      : [];
  const found = cookies.find(
    (c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`),
  );
  return found?.split(';')[0];
}
