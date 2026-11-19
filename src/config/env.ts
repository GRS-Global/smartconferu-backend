import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((value) => value === 'true');

/** A PEM key, given either as-is or base64-encoded (easier to keep on one line in a secret store). */
const pem = z.string().transform((value, ctx) => {
  const text = value.includes('-----BEGIN')
    ? value.replace(/\\n/g, '\n')
    : Buffer.from(value, 'base64').toString('utf8');
  if (!text.includes('-----BEGIN')) {
    ctx.addIssue({
      code: 'custom',
      message: 'must be a PEM key (or base64 of one)',
    });
    return z.NEVER;
  }
  return text;
});

/**
 * Every environment variable the API reads, validated once at startup. A missing or malformed
 * value stops the process with a clear message instead of failing later on first use.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  /** Postgres connection string. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Max pooled connections per API instance. */
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  /** Where the web app lives; links in emails point here. */
  APP_URL: z.url(),
  /** Comma-separated list of browser origins allowed to call the API. */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),

  /** Ed25519 private key (PKCS#8 PEM) that signs access tokens. */
  JWT_PRIVATE_KEY: pem,
  /** Identifies the signing key in the token header, so keys can be rotated. */
  JWT_KEY_ID: z.string().min(1).default('key-1'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(30),
  /** Secret mixed into the hashes of emailed codes and links. At least 32 characters. */
  TOKEN_HASH_SECRET: z.string().min(32),
  /**
   * SameSite for the refresh-token cookie. `lax` when the app and API share a site
   * (app.example.com + api.example.com); `none` when they're on unrelated domains.
   */
  REFRESH_COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  /** Defaults to true outside development. */
  REFRESH_COOKIE_SECURE: bool.optional(),
  /** 32 random bytes, base64: encrypts authenticator-app secrets at rest. */
  MFA_ENCRYPTION_KEY: z
    .string()
    .refine((value) => Buffer.from(value, 'base64').length === 32, {
      message: 'must be 32 bytes, base64-encoded',
    }),

  /** The API's own public address; sign-in providers redirect back to it. */
  API_URL: z.url(),
  // Sign-in providers. A provider is offered only when both its id and secret are set.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_ISSUER: z.url().default('https://accounts.google.com'),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  /** `common` (work, school and personal accounts), `organizations`, `consumers`, or a tenant id. */
  MICROSOFT_TENANT: z.string().default('common'),
  /** Override only for tests; otherwise derived from MICROSOFT_TENANT. */
  MICROSOFT_ISSUER: z.url().optional(),
  ORCID_CLIENT_ID: z.string().optional(),
  ORCID_CLIENT_SECRET: z.string().optional(),
  /** https://orcid.org, or https://sandbox.orcid.org for testing. */
  ORCID_ISSUER: z.url().default('https://orcid.org'),

  /** `log` writes emails to the log instead of sending them (development and tests). */
  EMAIL_TRANSPORT: z.enum(['resend', 'log']).default('log'),
  RESEND_API_KEY: z.string().optional(),
  /** e.g. "Smartconferu <no-reply@smartconferu.com>" */
  EMAIL_FROM: z.string().default('Smartconferu <no-reply@localhost>'),
  /**
   * Public URL of the logo shown at the top of emails. Empty: the app's own /smartconferu-lockup.png when
   * APP_URL is a public address; on localhost / a private address the name is written out instead (a mail
   * client cannot load an image from your computer).
   */
  EMAIL_LOGO_URL: z.url().optional(),
  /** Send the email queue from this process (off in tests, which send it on demand). */
  EMAIL_QUEUE_ENABLED: bool.default(true),
  /** How often the queue is checked for emails to send. */
  EMAIL_QUEUE_INTERVAL_MS: z.coerce.number().int().min(500).default(5000),
  /** Emails sent per batch (Resend takes up to 100 in one request). */
  EMAIL_QUEUE_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(50),
  /** Tries before an email is marked failed. */
  EMAIL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),

  /** Claude, for the AI features. Without it they answer 503. */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Only when the key is not scoped to one workspace. */
  ANTHROPIC_WORKSPACE_ID: z.string().optional(),
  /** Voyage AI embeddings, for paper chat (voyageai.com, pa-…). */
  VOYAGE_API_KEY: z.string().optional(),
  VOYAGE_BASE_URL: z.url().default('https://api.voyageai.com'),
  /** Prepare each new paper version for AI (text, embeddings, digest) right after upload. */
  AI_AUTO_INGEST: bool.default(true),

  /**
   * Share live events (new notifications) between API instances through Postgres LISTEN/NOTIFY.
   * Off only where one instance runs (tests); without it each instance pushes only its own events.
   */
  REALTIME_FANOUT: bool.default(true),

  /** Run the background jobs (review reminders, cleanup) from this process (off in tests). */
  JOBS_ENABLED: bool.default(true),
  /** How often the jobs run; each job decides itself what is due (reminders go out once a day). */
  JOBS_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),

  /** Where uploaded files (papers, reports) are kept. `local`: a folder on this machine (development). */
  FILE_STORAGE_DRIVER: z.enum(['local']).default('local'),
  /** The folder for FILE_STORAGE_DRIVER=local. */
  FILE_STORAGE_DIR: z.string().default('./storage'),
  /** Largest file accepted, in megabytes. */
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(25),

  /** Serve the OpenAPI docs at /docs. Off by default in production. */
  SWAGGER_ENABLED: bool.optional(),
  /** Turn rate limiting off (automated API tests only). */
  RATE_LIMIT_ENABLED: bool.default(true),
  /** Requests per minute allowed from one client IP. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema
    .superRefine((env, ctx) => {
      if (env.EMAIL_TRANSPORT === 'resend' && !env.RESEND_API_KEY) {
        ctx.addIssue({
          code: 'custom',
          path: ['RESEND_API_KEY'],
          message: 'is required when EMAIL_TRANSPORT=resend',
        });
      }
      if (env.NODE_ENV === 'production' && env.EMAIL_TRANSPORT === 'log') {
        ctx.addIssue({
          code: 'custom',
          path: ['EMAIL_TRANSPORT'],
          message: 'must not be "log" in production',
        });
      }
    })
    .safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}
