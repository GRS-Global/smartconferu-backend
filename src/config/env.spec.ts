import { generateKeyPairSync } from 'node:crypto';
import { validateEnv } from './env.js';

const pem = generateKeyPairSync('ed25519')
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

const minimal = {
  DATABASE_URL: 'postgresql://app:secret@db.example.com:5432/smartconferu',
  APP_URL: 'https://app.example.com',
  JWT_PRIVATE_KEY: pem,
  TOKEN_HASH_SECRET: 'x'.repeat(32),
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  API_URL: 'https://api.example.com',
};

describe('validateEnv', () => {
  it('applies defaults to a minimal configuration', () => {
    const env = validateEnv(minimal);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      DATABASE_POOL_MAX: 10,
      CORS_ORIGINS: ['http://localhost:5173'],
      ACCESS_TOKEN_TTL_SECONDS: 900,
      REFRESH_TOKEN_TTL_DAYS: 30,
      REFRESH_COOKIE_SAMESITE: 'lax',
      EMAIL_TRANSPORT: 'log',
      RATE_LIMIT_ENABLED: true,
    });
    // Unset means "decide by NODE_ENV" (see setupApp and the auth cookie).
    expect(env.SWAGGER_ENABLED).toBeUndefined();
    expect(env.REFRESH_COOKIE_SECURE).toBeUndefined();
  });

  it('parses lists, numbers and booleans from strings', () => {
    const env = validateEnv({
      ...minimal,
      PORT: '8080',
      CORS_ORIGINS: 'https://a.example, https://b.example ,',
      SWAGGER_ENABLED: 'false',
    });
    expect(env.PORT).toBe(8080);
    expect(env.CORS_ORIGINS).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    expect(env.SWAGGER_ENABLED).toBe(false);
  });

  it('accepts the signing key base64-encoded, as stored in a secret manager', () => {
    const env = validateEnv({
      ...minimal,
      JWT_PRIVATE_KEY: Buffer.from(pem).toString('base64'),
    });
    expect(env.JWT_PRIVATE_KEY).toBe(pem);
  });

  it('names every missing or invalid variable', () => {
    expect(() =>
      validateEnv({ DATABASE_URL: 'mysql://x', TOKEN_HASH_SECRET: 'short' }),
    ).toThrow(
      /DATABASE_URL[\s\S]*APP_URL[\s\S]*JWT_PRIVATE_KEY[\s\S]*TOKEN_HASH_SECRET/,
    );
  });

  it('refuses to run production without a real email provider', () => {
    expect(() => validateEnv({ ...minimal, NODE_ENV: 'production' })).toThrow(
      /EMAIL_TRANSPORT: must not be "log" in production/,
    );
    expect(() =>
      validateEnv({ ...minimal, EMAIL_TRANSPORT: 'resend' }),
    ).toThrow(/RESEND_API_KEY: is required/);
  });

  it('accepts only a sender the email provider takes', () => {
    for (const ok of [
      'Smartconferu <no-reply@gr-conferences.com>',
      'GR Conferences Team <hello@mail.example.org>',
      'no-reply@example.com',
      '  Smartconferu <no-reply@example.com>  ',
    ]) {
      expect(validateEnv({ ...minimal, EMAIL_FROM: ok }).EMAIL_FROM).toBe(
        ok.trim(),
      );
    }
    // A name without < > around the address is what Resend refuses with a 422 on every email.
    for (const bad of [
      'Smartconferu no-reply@gr-conferences.com',
      'Smartconferu',
      'Smartconferu <no-reply>',
      '<no-reply@example.com',
    ]) {
      expect(() => validateEnv({ ...minimal, EMAIL_FROM: bad })).toThrow(
        /EMAIL_FROM: must be "Name <address@domain>"/,
      );
    }
  });

  it('keeps files in a local folder unless S3 storage is set up in full', () => {
    expect(
      validateEnv({ ...minimal, S3_ENDPOINT: '', S3_BUCKET: '' }),
    ).toMatchObject({
      FILE_STORAGE_DRIVER: 'local',
      S3_REGION: 'auto',
      S3_FORCE_PATH_STYLE: true,
    });
    expect(() =>
      validateEnv({
        ...minimal,
        FILE_STORAGE_DRIVER: 's3',
        S3_BUCKET: 'papers',
      }),
    ).toThrow(
      /S3_ENDPOINT: is required[\s\S]*S3_ACCESS_KEY_ID: is required[\s\S]*S3_SECRET_ACCESS_KEY: is required/,
    );
    expect(() => validateEnv({ ...minimal, S3_ENDPOINT: 'not a url' })).toThrow(
      /S3_ENDPOINT/,
    );

    const env = validateEnv({
      ...minimal,
      FILE_STORAGE_DRIVER: 's3',
      S3_ENDPOINT: 'https://abc.r2.cloudflarestorage.com',
      S3_BUCKET: 'papers',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'secret',
    });
    expect(env).toMatchObject({
      FILE_STORAGE_DRIVER: 's3',
      S3_BUCKET: 'papers',
    });
  });

  it('never shows sign-in codes in API responses in production', () => {
    expect(validateEnv(minimal).DEV_SHOW_EMAIL_CODES).toBe(false);
    expect(() =>
      validateEnv({
        ...minimal,
        NODE_ENV: 'production',
        EMAIL_TRANSPORT: 'resend',
        RESEND_API_KEY: 're_x',
        DEV_SHOW_EMAIL_CODES: 'true',
      }),
    ).toThrow(/DEV_SHOW_EMAIL_CODES: must be off in production/);
  });
});
