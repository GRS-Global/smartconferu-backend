import { decodeJwt } from 'jose';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import {
  APP_ORIGIN,
  cookieFrom,
  createTestApp,
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

    it('must turn it on before using admin features', async () => {
      const admin = await t.createUser();
      await t.db.query('update users set is_super_admin = true where id = $1', [
        admin.id,
      ]);
      const { body } = await signIn(admin);

      const before = await adminAccess(body.accessToken).expect(403);
      expect(before.body.code).toBe('AUTH_MFA_SETUP_REQUIRED');

      const status = await http()
        .get('/api/v1/auth/mfa')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(200);
      expect(status.body.required).toBe(true);

      const setup = await http()
        .post('/api/v1/auth/mfa/totp/setup')
        .set('Authorization', `Bearer ${body.accessToken}`);
      const enabled = await http()
        .post('/api/v1/auth/mfa/totp/enable')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .send({ code: codeAt(setup.body.secret) })
        .expect(200);
      await adminAccess(enabled.body.accessToken).expect(200);
    });

    it('need a verified session, not only the password', async () => {
      const admin = await t.createUser();
      await t.db.query('update users set is_super_admin = true where id = $1', [
        admin.id,
      ]);
      await withMfa(admin);
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
