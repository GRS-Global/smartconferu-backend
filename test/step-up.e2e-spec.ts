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

/** "Confirm it's you": a fresh code before high-risk admin actions, good for 10 minutes. */
describe('Step-up verification', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  afterEach(() => t.reset());

  const http = () => request(t.app.getHttpServer());

  /** A super admin signed in for real (password + emailed code), so the session row exists. */
  async function adminSession(): Promise<{ admin: TestUser; token: string }> {
    const admin = await t.createUser();
    await t.db.query('update users set is_super_admin = true where id = $1', [
      admin.id,
    ]);
    const first = await http()
      .post('/api/v1/auth/sign-in')
      .send({ email: admin.email, password: admin.password })
      .expect(200);
    const done = await http()
      .post('/api/v1/auth/mfa/verify')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookieFrom(first.headers['set-cookie'], 'sc_mfa') ?? '')
      .send({ code: emailCode(t.outbox().at(-1)!.text) })
      .expect(200);
    return { admin, token: done.body.accessToken as string };
  }

  async function conference(token: string) {
    const chair = await t.createUser();
    const created = await http()
      .post('/api/v1/conferences')
      .set('Authorization', `Bearer ${await t.tokenFor(chair.id)}`)
      .send({ acronym: 'ICX 2027', title: 'International Conference X 2027' })
      .expect(201);
    await http()
      .post(`/api/v1/admin/conferences/${created.body.id}/decision`)
      .set('Authorization', `Bearer ${token}`)
      .send({ approve: true })
      .expect(204);
    return created.body.id as string;
  }

  const extend = (token: string, id: string) =>
    http()
      .post(`/api/v1/admin/conferences/${id}/license`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        expiry: new Date(Date.now() + 300 * 86_400_000)
          .toISOString()
          .slice(0, 10),
      });

  it('asks for a code, then allows high-risk actions for 10 minutes', async () => {
    const { token } = await adminSession();
    const id = await conference(token);
    const denied = await extend(token, id).expect(403);
    expect(denied.body.code).toBe('AUTH_STEP_UP_REQUIRED');

    const start = await http()
      .post('/api/v1/auth/step-up/code')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(start.body).toEqual({ factor: 'email' });
    const mail = t.outbox().at(-1)!;

    await http()
      .post('/api/v1/auth/step-up')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '000000' })
      .expect(401);
    await http()
      .post('/api/v1/auth/step-up')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: emailCode(mail.text) })
      .expect(204);
    await extend(token, id).expect(204);

    // Ten minutes later it is asked again.
    await t.db.query(
      "update sessions set step_up_at = now() - interval '11 minutes'",
    );
    await extend(token, id).expect(403);
  });

  it('uses the authenticator app when the admin has one', async () => {
    const { token } = await adminSession();
    const auth = `Bearer ${token}`;
    const setup = await http()
      .post('/api/v1/auth/mfa/totp/setup')
      .set('Authorization', auth)
      .expect(200);
    const secret = Secret.fromBase32(setup.body.secret as string);
    const at = (steps: number) =>
      new TOTP({ secret }).generate({ timestamp: Date.now() + steps * 30_000 });
    await http()
      .post('/api/v1/auth/mfa/totp/enable')
      .set('Authorization', auth)
      .send({ code: at(0) })
      .expect(200);
    const sent = t.outbox().length;
    const start = await http()
      .post('/api/v1/auth/step-up/code')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(start.body).toEqual({ factor: 'totp' });
    expect(t.outbox()).toHaveLength(sent);
    await http()
      .post('/api/v1/auth/step-up')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: at(1) })
      .expect(204);
  });

  it('is only for super admins', async () => {
    const user = await t.createUser();
    await http()
      .post('/api/v1/auth/step-up/code')
      .set('Authorization', `Bearer ${await t.tokenFor(user.id)}`)
      .expect(403);
  });
});
