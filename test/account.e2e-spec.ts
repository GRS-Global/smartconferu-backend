import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  APP_ORIGIN,
  cookieFrom,
  createTestApp,
  linkToken,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

describe('Account: email address and sessions', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  afterEach(() => t.reset());

  const http = () => request(t.app.getHttpServer());

  async function signIn(user: TestUser, userAgent = 'test-browser') {
    const res = await http()
      .post('/api/v1/auth/sign-in')
      .set('User-Agent', userAgent)
      .send({ email: user.email, password: user.password })
      .expect(200);
    return {
      bearer: `Bearer ${res.body.accessToken}`,
      refresh: cookieFrom(res.headers['set-cookie'], 'sc_refresh')!,
    };
  }

  const refresh = (cookie: string) =>
    http()
      .post('/api/v1/auth/refresh')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookie);

  describe('changing the email address', () => {
    it('changes it only once the new address is confirmed', async () => {
      const user = await t.createUser({ email: 'old@example.org' });
      const { bearer } = await signIn(user);

      await http()
        .post('/api/v1/auth/email/change')
        .set('Authorization', bearer)
        .send({ newEmail: 'New@Example.org', currentPassword: user.password })
        .expect(202);

      const [confirm, notice] = t.outbox().slice(-2);
      expect(confirm).toMatchObject({
        to: 'new@example.org',
        subject: 'Confirm your new email address',
      });
      expect(notice).toMatchObject({
        to: 'old@example.org',
        subject: 'Your email address is being changed',
      });

      // Nothing has changed yet.
      await http()
        .post('/api/v1/auth/sign-in')
        .send({ email: 'old@example.org', password: user.password })
        .expect(200);

      const token = linkToken(confirm.text);
      await http()
        .post('/api/v1/auth/email/change/confirm')
        .send({ token })
        .expect(204);
      expect(t.outbox().at(-1)).toMatchObject({
        to: 'old@example.org',
        subject: 'Your email address was changed',
      });

      await http()
        .post('/api/v1/auth/sign-in')
        .send({ email: 'new@example.org', password: user.password })
        .expect(200);
      await http()
        .post('/api/v1/auth/sign-in')
        .send({ email: 'old@example.org', password: user.password })
        .expect(401);
      await http()
        .post('/api/v1/auth/email/change/confirm')
        .send({ token })
        .expect(400);
    });

    it('needs the current password', async () => {
      const user = await t.createUser();
      const { bearer } = await signIn(user);
      const res = await http()
        .post('/api/v1/auth/email/change')
        .set('Authorization', bearer)
        .send({
          newEmail: 'new@example.org',
          currentPassword: 'wrong password',
        })
        .expect(400);
      expect(res.body.code).toBe('AUTH_INVALID_CREDENTIALS');
    });

    it('answers the same for an address that belongs to another account, and warns its owner', async () => {
      await t.createUser({ email: 'taken@example.org' });
      const user = await t.createUser();
      const { bearer } = await signIn(user);
      const before = t.outbox().length;
      await http()
        .post('/api/v1/auth/email/change')
        .set('Authorization', bearer)
        .send({ newEmail: 'taken@example.org', currentPassword: user.password })
        .expect(202);
      // Same answer as for a free address; no confirmation link is made, the owner is told instead.
      const sent = t.outbox().slice(before);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        to: 'taken@example.org',
        subject: 'Someone tried to use your email address',
      });
    });

    it('refuses the confirmation if the address was taken in the meantime', async () => {
      const user = await t.createUser();
      const { bearer } = await signIn(user);
      await http()
        .post('/api/v1/auth/email/change')
        .set('Authorization', bearer)
        .send({ newEmail: 'race@example.org', currentPassword: user.password })
        .expect(202);
      const token = linkToken(
        t.outbox().find((e) => e.to === 'race@example.org')!.text,
      );
      await t.createUser({ email: 'race@example.org' });
      await http()
        .post('/api/v1/auth/email/change/confirm')
        .send({ token })
        .expect(409);
    });
  });

  describe('sessions', () => {
    it('lists signed-in devices and marks the current one', async () => {
      const user = await t.createUser();
      const laptop = await signIn(user, 'Laptop Firefox');
      await signIn(user, 'Phone Safari');

      const res = await http()
        .get('/api/v1/auth/sessions')
        .set('Authorization', laptop.bearer)
        .expect(200);
      expect(res.body).toHaveLength(2);
      expect(
        res.body.find((s: { current: boolean }) => s.current),
      ).toMatchObject({
        userAgent: 'Laptop Firefox',
        mfaVerified: false,
      });
    });

    it('keeps one entry per device across refreshes', async () => {
      const user = await t.createUser();
      const laptop = await signIn(user);
      const next = cookieFrom(
        (await refresh(laptop.refresh).expect(200)).headers['set-cookie'],
        'sc_refresh',
      )!;
      await refresh(next).expect(200);
      const res = await http()
        .get('/api/v1/auth/sessions')
        .set('Authorization', laptop.bearer)
        .expect(200);
      expect(res.body).toHaveLength(1);
    });

    it('signs out another device', async () => {
      const user = await t.createUser();
      const laptop = await signIn(user, 'Laptop');
      const phone = await signIn(user, 'Phone');
      const list = await http()
        .get('/api/v1/auth/sessions')
        .set('Authorization', laptop.bearer);
      const phoneSession = list.body.find(
        (s: { userAgent: string }) => s.userAgent === 'Phone',
      );

      await http()
        .delete(`/api/v1/auth/sessions/${phoneSession.id}`)
        .set('Authorization', laptop.bearer)
        .expect(204);
      await refresh(phone.refresh).expect(401);
      await refresh(laptop.refresh).expect(200);

      const after = await http()
        .get('/api/v1/auth/sessions')
        .set('Authorization', laptop.bearer);
      expect(after.body).toHaveLength(1);
    });

    it("can't touch someone else's session", async () => {
      const alice = await t.createUser();
      const bob = await t.createUser();
      const bobSession = await signIn(bob);
      const [session] = (
        await http()
          .get('/api/v1/auth/sessions')
          .set('Authorization', bobSession.bearer)
      ).body;

      const aliceBearer = (await signIn(alice)).bearer;
      await http()
        .delete(`/api/v1/auth/sessions/${session.id}`)
        .set('Authorization', aliceBearer)
        .expect(404);
      await http()
        .delete(`/api/v1/auth/sessions/${randomUUID()}`)
        .set('Authorization', aliceBearer)
        .expect(404);
      await refresh(bobSession.refresh).expect(200);
    });
  });
});
