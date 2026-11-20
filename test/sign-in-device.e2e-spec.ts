import { decodeJwt } from 'jose';
import request from 'supertest';
import {
  APP_ORIGIN,
  cookieFrom,
  createTestApp,
  emailCode,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

/** The raw Set-Cookie line for a cookie (attributes included), to check how long it lives. */
const rawCookie = (setCookie: unknown, name: string): string | undefined =>
  (Array.isArray(setCookie) ? (setCookie as string[]) : []).find((c) =>
    c.startsWith(`${name}=`),
  );

describe('Sign-in on this device ("Keep me signed in", "Trust this device")', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  afterEach(() => t.reset());

  const http = () => request(t.app.getHttpServer());

  const makeSuperAdmin = (id: string) =>
    t.db.query('update users set is_super_admin = true where id = $1', [id]);

  const signIn = (
    user: TestUser,
    body: Record<string, unknown> = {},
    cookie = '',
  ) =>
    http()
      .post('/api/v1/auth/sign-in')
      .set('Cookie', cookie)
      .send({ email: user.email, password: user.password, ...body })
      .expect(200);

  /** A super admin's password + emailed code; returns the response of the code step. */
  async function adminSignIn(
    admin: TestUser,
    { remember, trustDevice }: { remember?: boolean; trustDevice?: boolean },
  ) {
    const first = await signIn(
      admin,
      remember === undefined ? {} : { remember },
    );
    expect(first.body).toMatchObject({ mfaRequired: true, factor: 'email' });
    return http()
      .post('/api/v1/auth/mfa/verify')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookieFrom(first.headers['set-cookie'], 'sc_mfa') ?? '')
      .send({
        code: emailCode(t.outbox().at(-1)!.text),
        ...(trustDevice === undefined ? {} : { trustDevice }),
      })
      .expect(200);
  }

  describe('Keep me signed in', () => {
    it('on (the default): the refresh cookie outlives the browser', async () => {
      const user = await t.createUser();
      const res = await signIn(user);
      expect(rawCookie(res.headers['set-cookie'], 'sc_refresh')).toMatch(
        /Expires=/,
      );
    });

    it('off: a browser-session cookie, kept that way across refreshes', async () => {
      const user = await t.createUser();
      const res = await signIn(user, { remember: false });
      const line = rawCookie(res.headers['set-cookie'], 'sc_refresh');
      expect(line).toBeDefined();
      expect(line).not.toMatch(/Expires=|Max-Age=/);

      const refreshed = await http()
        .post('/api/v1/auth/refresh')
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookieFrom(res.headers['set-cookie'], 'sc_refresh')!)
        .expect(200);
      expect(
        rawCookie(refreshed.headers['set-cookie'], 'sc_refresh'),
      ).not.toMatch(/Expires=|Max-Age=/);

      // And the session itself ends after a short idle time, not the full 30 days.
      const { rows } = await t.db.query<{ hours: number }>(
        `select extract(epoch from (expires_at - created_at)) / 3600 as hours
           from sessions where user_id = $1 order by created_at desc limit 1`,
        [user.id],
      );
      expect(Number(rows[0].hours)).toBeLessThanOrEqual(12.01);
    });

    it('is carried through the emailed admin code', async () => {
      const admin = await t.createUser();
      await makeSuperAdmin(admin.id);
      const done = await adminSignIn(admin, { remember: false });
      expect(rawCookie(done.headers['set-cookie'], 'sc_refresh')).not.toMatch(
        /Expires=|Max-Age=/,
      );
      const kept = await adminSignIn(admin, {});
      expect(rawCookie(kept.headers['set-cookie'], 'sc_refresh')).toMatch(
        /Expires=/,
      );
    });
  });

  describe('Trust this device', () => {
    it('skips the emailed code at the next password sign-in, as a verified session', async () => {
      const admin = await t.createUser();
      await makeSuperAdmin(admin.id);
      const done = await adminSignIn(admin, { trustDevice: true });
      const trusted = cookieFrom(done.headers['set-cookie'], 'sc_trusted');
      expect(trusted).toBeDefined();
      expect(rawCookie(done.headers['set-cookie'], 'sc_trusted')).toMatch(
        /HttpOnly/i,
      );

      const sent = t.outbox().length;
      const again = await signIn(admin, {}, trusted);
      expect(again.body.mfaRequired).toBeUndefined();
      expect(decodeJwt(again.body.accessToken).mfa).toBe(true);
      expect(t.outbox()).toHaveLength(sent);
      await http()
        .get('/api/v1/admin/access')
        .set('Authorization', `Bearer ${again.body.accessToken}`)
        .expect(200);
    });

    it('is not given unless asked for', async () => {
      const admin = await t.createUser();
      await makeSuperAdmin(admin.id);
      const done = await adminSignIn(admin, {});
      expect(cookieFrom(done.headers['set-cookie'], 'sc_trusted')).toBe(
        undefined,
      );
    });

    it('only vouches for the admin who trusted the browser, and never stands in for the password', async () => {
      const a = await t.createUser();
      const b = await t.createUser();
      await makeSuperAdmin(a.id);
      await makeSuperAdmin(b.id);
      const done = await adminSignIn(a, { trustDevice: true });
      const trusted = cookieFrom(done.headers['set-cookie'], 'sc_trusted')!;

      const other = await signIn(b, {}, trusted);
      expect(other.body).toMatchObject({ mfaRequired: true, factor: 'email' });

      await http()
        .post('/api/v1/auth/sign-in')
        .set('Cookie', trusted)
        .send({ email: a.email, password: 'wrong password here' })
        .expect(401);
    });

    it('"Forget this device" asks for the code again', async () => {
      const admin = await t.createUser();
      await makeSuperAdmin(admin.id);
      const done = await adminSignIn(admin, { trustDevice: true });
      const trusted = cookieFrom(done.headers['set-cookie'], 'sc_trusted')!;

      const forgot = await http()
        .post('/api/v1/auth/trusted-device/forget')
        .set('Origin', APP_ORIGIN)
        .set('Cookie', trusted)
        .expect(204);
      expect(rawCookie(forgot.headers['set-cookie'], 'sc_trusted')).toMatch(
        /sc_trusted=;/,
      );

      const again = await signIn(admin, {}, trusted);
      expect(again.body).toMatchObject({ mfaRequired: true, factor: 'email' });
    });

    it('signing out everywhere ends every trust', async () => {
      const admin = await t.createUser();
      await makeSuperAdmin(admin.id);
      const done = await adminSignIn(admin, { trustDevice: true });
      const trusted = cookieFrom(done.headers['set-cookie'], 'sc_trusted')!;

      await http()
        .post('/api/v1/auth/sign-out/everywhere')
        .set('Origin', APP_ORIGIN)
        .set('Authorization', `Bearer ${done.body.accessToken}`)
        .expect(204);

      const again = await signIn(admin, {}, trusted);
      expect(again.body).toMatchObject({ mfaRequired: true, factor: 'email' });
    });
  });
});
