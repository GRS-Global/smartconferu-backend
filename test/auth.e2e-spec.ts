import bcrypt from 'bcryptjs';
import { createLocalJWKSet, jwtVerify } from 'jose';
import request from 'supertest';
import {
  API_URL,
  APP_ORIGIN,
  createTestApp,
  emailCode,
  linkToken,
  refreshCookie,
  type TestApp,
} from './support/test-app.js';

describe('/api/v1/auth', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  afterEach(() => t.reset());

  const http = () => request(t.app.getHttpServer());
  const lastEmail = () => {
    const sent = t.outbox();
    expect(sent.length).toBeGreaterThan(0);
    return sent[sent.length - 1];
  };
  const signIn = (email: string, password: string) =>
    http().post('/api/v1/auth/sign-in').send({ email, password });
  const refresh = (cookie: string) =>
    http()
      .post('/api/v1/auth/refresh')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookie);

  describe('registration and email verification', () => {
    const registration = {
      email: 'Ada@Example.org',
      password: 'analytical engine',
      firstName: 'Ada',
      lastName: 'Lovelace',
      affiliation: 'Royal Society',
      designation: 'Professor',
      country: 'United Kingdom',
      termsVersion: '2026-10-01',
      details: {
        gender: 'Female',
        phone: '+44 7700 900123',
        notifyChannels: ['whatsapp'],
        webPage: 'https://example.org',
      },
    };

    it('creates an unverified account and emails a confirmation link', async () => {
      await http().post('/api/v1/auth/register').send(registration).expect(202);

      const email = lastEmail();
      expect(email.to).toBe('ada@example.org');
      expect(email.subject).toBe('Confirm your email address');

      const res = await signIn('ada@example.org', registration.password);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTH_EMAIL_NOT_VERIFIED');
    });

    it('signs the user in from the link, once', async () => {
      await http().post('/api/v1/auth/register').send(registration);
      const token = linkToken(lastEmail().text);

      const res = await http()
        .post('/api/v1/auth/verify-email')
        .send({ token })
        .expect(200);
      expect(res.body).toMatchObject({
        tokenType: 'Bearer',
        expiresIn: 900,
        user: {
          email: 'ada@example.org',
          emailVerified: true,
          isSuperAdmin: false,
        },
      });
      const cookie = String(res.headers['set-cookie']);
      expect(cookie).toMatch(
        /sc_refresh=.+; Path=\/api\/v1\/auth; Expires=.+; HttpOnly; Secure; SameSite=Lax/,
      );

      const me = await http()
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`)
        .expect(200);
      expect(me.body).toMatchObject({
        firstName: 'Ada',
        affiliation: 'Royal Society',
        designation: 'Professor',
        country: 'United Kingdom',
        emailVerified: true,
        termsVersion: '2026-10-01',
        details: registration.details,
      });
      expect(Date.parse(me.body.termsAcceptedAt)).toBeGreaterThan(
        Date.now() - 60_000,
      );

      const again = await http()
        .post('/api/v1/auth/verify-email')
        .send({ token })
        .expect(400);
      expect(again.body.code).toBe('AUTH_INVALID_LINK');
    });

    it('does not reveal that an address is taken', async () => {
      const existing = await t.createUser({ email: 'taken@example.org' });
      const res = await http()
        .post('/api/v1/auth/register')
        .send({ ...registration, email: existing.email })
        .expect(202);
      expect(res.body.message).toBe(
        'Check your email to confirm your address.',
      );
      expect(lastEmail().subject).toBe(
        'You already have a Smartconferu account',
      );

      const { rows } = await t.db.query('select count(*)::int as n from users');
      expect(rows).toEqual([{ n: 1 }]);
    });

    it('requires the Terms to be accepted', async () => {
      const { termsVersion: _, ...withoutTerms } = registration;
      const res = await http()
        .post('/api/v1/auth/register')
        .send(withoutTerms)
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(t.outbox()).toHaveLength(0);
    });

    it('caps the size of the profile details', async () => {
      const res = await http()
        .post('/api/v1/auth/register')
        .send({ ...registration, details: { notes: 'x'.repeat(25_000) } })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('refuses weak passwords', async () => {
      const res = await http()
        .post('/api/v1/auth/register')
        .send({ ...registration, password: 'short' })
        .expect(400);
      expect(res.body.code).toBe('AUTH_WEAK_PASSWORD');
    });

    it('links committee invitations waiting for the address', async () => {
      const chair = await t.createUser();
      await t.db.query(
        `insert into conferences (id, slug, acronym, title, created_by)
         values ('11111111-1111-4111-8111-111111111111', 'icx', 'ICX', 'ICX', $1)`,
        [chair.id],
      );
      await t.db.query(
        `insert into conference_members (conference_id, invited_email, role)
         values ('11111111-1111-4111-8111-111111111111', 'ADA@example.org', 'reviewer')`,
      );

      await http().post('/api/v1/auth/register').send(registration);
      const verified = await http()
        .post('/api/v1/auth/verify-email')
        .send({ token: linkToken(lastEmail().text) })
        .expect(200);

      const { rows } = await t.db.query<{ user_id: string }>(
        `select user_id from conference_members where role = 'reviewer'`,
      );
      expect(rows[0].user_id).toBe(verified.body.user.id);
    });
  });

  describe('password sign-in', () => {
    it('returns an access token and sets the refresh cookie', async () => {
      const user = await t.createUser({ email: 'grace@example.org' });
      const res = await signIn('  GRACE@example.org ', user.password).expect(
        200,
      );
      expect(res.body.user).toEqual({
        id: user.id,
        email: 'grace@example.org',
        emailVerified: true,
        isSuperAdmin: false,
      });
      expect(() => refreshCookie(res.headers['set-cookie'])).not.toThrow();
    });

    it('answers the same for a wrong password and an unknown account', async () => {
      const user = await t.createUser();
      const wrong = await signIn(user.email, 'not the password').expect(401);
      const unknown = await signIn(
        'nobody@example.org',
        'whatever pass',
      ).expect(401);
      expect(wrong.body.code).toBe('AUTH_INVALID_CREDENTIALS');
      expect(unknown.body.message).toBe(wrong.body.message);
    });

    it('locks the account for 15 minutes after 5 wrong passwords', async () => {
      const user = await t.createUser();
      for (let i = 0; i < 5; i++) {
        await signIn(user.email, `wrong ${i} password`).expect(401);
      }
      const res = await signIn(user.email, user.password).expect(429);
      expect(res.body.code).toBe('AUTH_ACCOUNT_LOCKED');
      expect(res.body.message).toMatch(/15 minutes/);
    });

    it('accepts a bcrypt hash carried over from the old system and upgrades it', async () => {
      const user = await t.createUser();
      await t.db.query('update users set password_hash = $1 where id = $2', [
        await bcrypt.hash('from supabase', 4),
        user.id,
      ]);
      await signIn(user.email, 'from supabase').expect(200);

      const { rows } = await t.db.query<{ password_hash: string }>(
        'select password_hash from users where id = $1',
        [user.id],
      );
      expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
      await signIn(user.email, 'from supabase').expect(200);
    });

    it('refuses disabled accounts', async () => {
      const user = await t.createUser();
      await t.db.query(`update users set status = 'disabled' where id = $1`, [
        user.id,
      ]);
      const res = await signIn(user.email, user.password).expect(403);
      expect(res.body.code).toBe('AUTH_ACCOUNT_DISABLED');
    });
  });

  describe('sign-in code', () => {
    it('signs in with the emailed code, once', async () => {
      const user = await t.createUser();
      await http()
        .post('/api/v1/auth/sign-in/code')
        .send({ email: user.email })
        .expect(202);
      const code = emailCode(lastEmail().text);

      await http()
        .post('/api/v1/auth/sign-in/code/verify')
        .send({ email: user.email, code })
        .expect(200);
      const reuse = await http()
        .post('/api/v1/auth/sign-in/code/verify')
        .send({ email: user.email, code })
        .expect(401);
      expect(reuse.body.code).toBe('AUTH_INVALID_CODE');
    });

    it('stops accepting a code after 5 wrong guesses', async () => {
      const user = await t.createUser();
      await http()
        .post('/api/v1/auth/sign-in/code')
        .send({ email: user.email });
      const code = emailCode(lastEmail().text);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) {
        await http()
          .post('/api/v1/auth/sign-in/code/verify')
          .send({ email: user.email, code: wrong })
          .expect(401);
      }
      await http()
        .post('/api/v1/auth/sign-in/code/verify')
        .send({ email: user.email, code })
        .expect(401);
    });

    it('sends nothing for an unknown address, but answers the same', async () => {
      const res = await http()
        .post('/api/v1/auth/sign-in/code')
        .send({ email: 'nobody@example.org' })
        .expect(202);
      expect(res.body.message).toMatch(/If an account exists/);
      expect(t.outbox()).toHaveLength(0);
    });
  });

  describe('refresh tokens', () => {
    it('rotates: each refresh returns a new token and a working access token', async () => {
      const user = await t.createUser();
      const first = refreshCookie(
        (await signIn(user.email, user.password)).headers['set-cookie'],
      );

      const res = await refresh(first).expect(200);
      const second = refreshCookie(res.headers['set-cookie']);
      expect(second).not.toBe(first);
      await http()
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`)
        .expect(200);
      await refresh(second).expect(200);
    });

    it('tolerates two tabs refreshing at once without ending the session', async () => {
      const user = await t.createUser();
      const first = refreshCookie(
        (await signIn(user.email, user.password)).headers['set-cookie'],
      );
      const second = refreshCookie(
        (await refresh(first).expect(200)).headers['set-cookie'],
      );

      await refresh(first).expect(401);
      await refresh(second).expect(200);
    });

    it('revokes the whole session when an old token is replayed later', async () => {
      const user = await t.createUser();
      const first = refreshCookie(
        (await signIn(user.email, user.password)).headers['set-cookie'],
      );
      const second = refreshCookie(
        (await refresh(first).expect(200)).headers['set-cookie'],
      );
      await t.db.query(
        `update sessions set rotated_at = now() - interval '1 minute' where rotated_at is not null`,
      );

      const replay = await refresh(first).expect(401);
      expect(replay.body.code).toBe('AUTH_SESSION_EXPIRED');
      await refresh(second).expect(401);

      const { rows } = await t.db.query(
        `select 1 from audit_log where action = 'auth.refresh_token_reused' and actor_id = $1`,
        [user.id],
      );
      expect(rows).toHaveLength(1);
    });

    it('refuses refresh requests from other sites', async () => {
      const user = await t.createUser();
      const cookie = refreshCookie(
        (await signIn(user.email, user.password)).headers['set-cookie'],
      );
      const res = await http()
        .post('/api/v1/auth/refresh')
        .set('Origin', 'https://evil.example')
        .set('Cookie', cookie)
        .expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('accepts refresh from the API docs page (same origin)', async () => {
      const user = await t.createUser();
      const cookie = refreshCookie(
        (await signIn(user.email, user.password)).headers['set-cookie'],
      );
      await http()
        .post('/api/v1/auth/refresh')
        .set('Origin', API_URL)
        .set('Cookie', cookie)
        .expect(200);
    });

    it('ends the session on sign-out', async () => {
      const user = await t.createUser();
      const cookie = refreshCookie(
        (await signIn(user.email, user.password)).headers['set-cookie'],
      );
      const res = await http()
        .post('/api/v1/auth/sign-out')
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookie)
        .expect(204);
      expect(String(res.headers['set-cookie'])).toMatch(/sc_refresh=;/);
      await refresh(cookie).expect(401);
    });

    it('ends every session on sign-out everywhere', async () => {
      const user = await t.createUser();
      const laptop = await signIn(user.email, user.password);
      const phone = refreshCookie(
        (await signIn(user.email, user.password)).headers['set-cookie'],
      );
      await http()
        .post('/api/v1/auth/sign-out/everywhere')
        .set('Authorization', `Bearer ${laptop.body.accessToken}`)
        .expect(204);
      await refresh(phone).expect(401);
      await refresh(refreshCookie(laptop.headers['set-cookie'])).expect(401);
    });
  });

  describe('passwords', () => {
    it('resets a forgotten password and signs out every session', async () => {
      const user = await t.createUser();
      const session = refreshCookie(
        (await signIn(user.email, user.password)).headers['set-cookie'],
      );

      await http()
        .post('/api/v1/auth/password/forgot')
        .send({ email: user.email })
        .expect(202);
      const token = linkToken(lastEmail().text);
      await http()
        .post('/api/v1/auth/password/reset')
        .send({ token, password: 'a brand new secret' })
        .expect(204);

      expect(lastEmail().subject).toBe('Your password was changed');
      await refresh(session).expect(401);
      await signIn(user.email, user.password).expect(401);
      await signIn(user.email, 'a brand new secret').expect(200);
      await http()
        .post('/api/v1/auth/password/reset')
        .send({ token, password: 'yet another secret' })
        .expect(400);
    });

    it('changes the password, keeping only the current session', async () => {
      const user = await t.createUser();
      const current = await signIn(user.email, user.password);
      const other = refreshCookie(
        (await signIn(user.email, user.password)).headers['set-cookie'],
      );
      const bearer = `Bearer ${current.body.accessToken}`;

      const wrong = await http()
        .post('/api/v1/auth/password/change')
        .set('Authorization', bearer)
        .send({
          currentPassword: 'nope nope nope',
          newPassword: 'better password',
        })
        .expect(400);
      expect(wrong.body.code).toBe('AUTH_INVALID_CREDENTIALS');

      await http()
        .post('/api/v1/auth/password/change')
        .set('Authorization', bearer)
        .send({
          currentPassword: user.password,
          newPassword: 'better password',
        })
        .expect(204);
      await refresh(other).expect(401);
      await refresh(refreshCookie(current.headers['set-cookie'])).expect(200);
      await signIn(user.email, 'better password').expect(200);
    });
  });

  describe('access tokens', () => {
    it('can be verified by anyone with the published JWKS', async () => {
      const user = await t.createUser();
      const { body } = await signIn(user.email, user.password);
      const jwks = await http().get('/.well-known/jwks.json').expect(200);
      const { payload } = await jwtVerify(
        body.accessToken,
        createLocalJWKSet(jwks.body),
        {
          issuer: 'smartconferu-api',
          audience: 'smartconferu',
        },
      );
      expect(payload.sub).toBe(user.id);
    });

    it('rejects a tampered token', async () => {
      const user = await t.createUser();
      const { body } = await signIn(user.email, user.password);
      const [header, , signature] = (body.accessToken as string).split('.');
      const forged = Buffer.from(
        JSON.stringify({ sub: 'someone-else', sid: 'x' }),
      ).toString('base64url');
      const res = await http()
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${header}.${forged}.${signature}`)
        .expect(401);
      expect(res.body.code).toBe('AUTH_INVALID_TOKEN');
    });
  });

  it('keeps an audit trail of sign-ins', async () => {
    const user = await t.createUser();
    await signIn(user.email, 'wrong password!').expect(401);
    await signIn(user.email, user.password)
      .set('User-Agent', 'vitest')
      .expect(200);
    const { rows } = await t.db.query<{
      action: string;
      user_agent: string | null;
    }>(
      'select action, user_agent from audit_log where actor_id = $1 order by id',
      [user.id],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'auth.sign_in_failed',
      'auth.sign_in',
    ]);
    expect(rows[1].user_agent).toBe('vitest');
  });
});
