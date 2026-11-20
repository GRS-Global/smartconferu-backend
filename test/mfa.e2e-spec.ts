import { decodeJwt } from 'jose';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import {
  APP_ORIGIN,
  cookieFrom,
  createTestApp,
  emailCode,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

describe('Two-step verification (authenticator app)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  afterEach(() => t.reset());

  const http = () => request(t.app.getHttpServer());

  /** The code the app would show `steps` × 30 s from now (each step can be used once). */
  const codeAt = (secret: string, steps = 0) =>
    new TOTP({ secret: Secret.fromBase32(secret) }).generate({
      timestamp: Date.now() + steps * 30_000,
    });

  async function signIn(user: TestUser) {
    const res = await http()
      .post('/api/v1/auth/sign-in')
      .send({ email: user.email, password: user.password })
      .expect(200);
    return {
      body: res.body,
      mfaCookie: cookieFrom(res.headers['set-cookie'], 'sc_mfa'),
      refresh: cookieFrom(res.headers['set-cookie'], 'sc_refresh'),
    };
  }

  /** Signs in and turns MFA on; returns the secret, recovery codes and a verified token. */
  async function withMfa(user: TestUser) {
    const { body } = await signIn(user);
    const bearer = `Bearer ${body.accessToken}`;
    const setup = await http()
      .post('/api/v1/auth/mfa/totp/setup')
      .set('Authorization', bearer)
      .expect(200);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Smartconferu:/);
    const enabled = await http()
      .post('/api/v1/auth/mfa/totp/enable')
      .set('Authorization', bearer)
      .send({ code: codeAt(setup.body.secret) })
      .expect(200);
    return {
      secret: setup.body.secret as string,
      recoveryCodes: enabled.body.recoveryCodes as string[],
      accessToken: enabled.body.accessToken as string,
    };
  }

  const verify = (mfaCookie: string | undefined, code: string) =>
    http()
      .post('/api/v1/auth/mfa/verify')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', mfaCookie ?? '')
      .send({ code });

  it('turns on with a first code and hands out 10 recovery codes', async () => {
    const user = await t.createUser();
    const { recoveryCodes, accessToken } = await withMfa(user);
    expect(recoveryCodes).toHaveLength(10);
    expect(recoveryCodes[0]).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(decodeJwt(accessToken).mfa).toBe(true);

    const status = await http()
      .get('/api/v1/auth/mfa')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(status.body).toEqual({
      enabled: true,
      recoveryCodesLeft: 10,
      required: false,
    });
    expect(t.outbox().at(-1)?.subject).toBe('Two-step verification is on');
  });

  it('stores the secret encrypted', async () => {
    const user = await t.createUser();
    const { secret } = await withMfa(user);
    const { rows } = await t.db.query<{ totp_secret: string }>(
      'select totp_secret from user_mfa',
    );
    expect(rows[0].totp_secret).not.toContain(secret);
  });

  it('asks for a code after the password, then signs in', async () => {
    const user = await t.createUser();
    const { secret } = await withMfa(user);

    const first = await signIn(user);
    expect(first.body).toEqual({
      mfaRequired: true,
      factor: 'totp',
      message: 'Enter the code from your authenticator app.',
    });
    expect(first.refresh).toBeUndefined();
    expect(first.mfaCookie).toBeDefined();

    const res = await verify(first.mfaCookie, codeAt(secret, 1)).expect(200);
    expect(decodeJwt(res.body.accessToken).mfa).toBe(true);
    expect(cookieFrom(res.headers['set-cookie'], 'sc_refresh')).toBeDefined();

    // Refreshing keeps the session verified.
    const refreshed = await http()
      .post('/api/v1/auth/refresh')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookieFrom(res.headers['set-cookie'], 'sc_refresh')!)
      .expect(200);
    expect(decodeJwt(refreshed.body.accessToken).mfa).toBe(true);
  });

  it('never accepts the same code twice', async () => {
    const user = await t.createUser();
    const { secret } = await withMfa(user);
    const code = codeAt(secret, 1);
    await verify((await signIn(user)).mfaCookie, code).expect(200);
    const replay = await verify((await signIn(user)).mfaCookie, code).expect(
      401,
    );
    expect(replay.body.code).toBe('AUTH_INVALID_CODE');
  });

  it('accepts each recovery code once', async () => {
    const user = await t.createUser();
    const { recoveryCodes } = await withMfa(user);
    await verify(
      (await signIn(user)).mfaCookie,
      recoveryCodes[0].toUpperCase(),
    ).expect(200);
    await verify((await signIn(user)).mfaCookie, recoveryCodes[0]).expect(401);
  });

  it('locks the account after 5 wrong codes', async () => {
    const user = await t.createUser();
    await withMfa(user);
    const { mfaCookie } = await signIn(user);
    for (let i = 0; i < 5; i++) {
      await verify(mfaCookie, '000000').expect(401);
    }
    const res = await verify(mfaCookie, '000000').expect(429);
    expect(res.body.code).toBe('AUTH_ACCOUNT_LOCKED');
  });

  it('times out without the challenge cookie', async () => {
    const res = await verify(undefined, '123456').expect(401);
    expect(res.body.code).toBe('AUTH_SESSION_EXPIRED');
  });

  it('turns off only with a valid code', async () => {
    const user = await t.createUser();
    const { secret, accessToken } = await withMfa(user);
    const bearer = `Bearer ${accessToken}`;
    await http()
      .post('/api/v1/auth/mfa/totp/disable')
      .set('Authorization', bearer)
      .send({ code: '000000' })
      .expect(401);
    await http()
      .post('/api/v1/auth/mfa/totp/disable')
      .set('Authorization', bearer)
      .send({ code: codeAt(secret, 1) })
      .expect(204);
    const after = await signIn(user);
    expect(after.body.accessToken).toBeDefined();
  });

  it('signs out other devices when turned on', async () => {
    const user = await t.createUser();
    const other = await signIn(user);
    await withMfa(user);
    await http()
      .post('/api/v1/auth/refresh')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', other.refresh!)
      .expect(401);
  });

  describe('super admins', () => {
    const adminAccess = (token: string) =>
      http()
        .get('/api/v1/admin/access')
        .set('Authorization', `Bearer ${token}`);

    const makeSuperAdmin = (id: string) =>
      t.db.query('update users set is_super_admin = true where id = $1', [id]);

    it('without an authenticator app, finish a password sign-in with an emailed code', async () => {
      const admin = await t.createUser();
      await makeSuperAdmin(admin.id);
      const first = await signIn(admin);
      expect(first.body).toMatchObject({ mfaRequired: true, factor: 'email' });
      expect(first.body.accessToken).toBeUndefined();
      expect(first.body.devCode).toBeUndefined();
      const mail = t.outbox().at(-1)!;
      expect(mail.to).toBe(admin.email);
      expect(mail.subject).toMatch(/admin sign-in code/);

      const wrong = await verify(first.mfaCookie, '000000').expect(401);
      expect(wrong.body.code).toBe('AUTH_INVALID_CODE');

      // "Send a new code": only the newest code works.
      await http()
        .post('/api/v1/auth/mfa/email-code')
        .set('Origin', APP_ORIGIN)
        .set('Cookie', first.mfaCookie ?? '')
        .expect(200);
      const resent = t.outbox().at(-1)!;
      expect(resent.subject).not.toBe(mail.subject);
      await verify(first.mfaCookie, emailCode(mail.text)).expect(401);

      const done = await verify(first.mfaCookie, emailCode(resent.text)).expect(
        200,
      );
      expect(decodeJwt(done.body.accessToken).mfa).toBe(true);
      await adminAccess(done.body.accessToken).expect(200);
    });

    it('a sign-in code alone opens the app, not the admin features', async () => {
      const admin = await t.createUser();
      await makeSuperAdmin(admin.id);
      await http()
        .post('/api/v1/auth/sign-in/code')
        .send({ email: admin.email })
        .expect(202);
      const res = await http()
        .post('/api/v1/auth/sign-in/code/verify')
        .send({ email: admin.email, code: emailCode(t.outbox().at(-1)!.text) })
        .expect(200);
      const denied = await adminAccess(res.body.accessToken).expect(403);
      expect(denied.body.code).toBe('AUTH_MFA_REQUIRED');
    });

    it('with an authenticator app, use it instead of an email', async () => {
      const admin = await t.createUser();
      const { secret } = await withMfa(admin);
      await makeSuperAdmin(admin.id);
      const sent = t.outbox().length;
      const first = await signIn(admin);
      expect(first.body).toMatchObject({ mfaRequired: true, factor: 'totp' });
      expect(t.outbox()).toHaveLength(sent);
      const done = await verify(first.mfaCookie, codeAt(secret, 1)).expect(200);
      await adminAccess(done.body.accessToken).expect(200);
      // No emailed code for an authenticator-app challenge.
      await http()
        .post('/api/v1/auth/mfa/email-code')
        .set('Origin', APP_ORIGIN)
        .set('Cookie', first.mfaCookie ?? '')
        .expect(401);
    });

    it('need a verified session, not only the password', async () => {
      const admin = await t.createUser();
      await withMfa(admin);
      await makeSuperAdmin(admin.id);
      const res = await adminAccess(await t.tokenFor(admin.id, false)).expect(
        403,
      );
      expect(res.body.code).toBe('AUTH_MFA_REQUIRED');
    });

    it('keep everyone else out', async () => {
      const user = await t.createUser();
      const res = await adminAccess(await t.tokenFor(user.id, true)).expect(
        403,
      );
      expect(res.body.code).toBe('FORBIDDEN');
    });
  });
});
