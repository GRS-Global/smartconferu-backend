import request from 'supertest';
import {
  APP_ORIGIN,
  cookieFrom,
  createTestApp,
  emailCode,
  type TestApp,
} from './support/test-app.js';

describe('Admin sign-in code in the response (DEV_SHOW_EMAIL_CODES, development only)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ DEV_SHOW_EMAIL_CODES: 'true' });
  });
  afterAll(() => t.close());
  afterEach(() => t.reset());

  const http = () => request(t.app.getHttpServer());

  it('returns the emailed code on sign-in and on "Send a new code"', async () => {
    const admin = await t.createUser();
    await t.db.query('update users set is_super_admin = true where id = $1', [
      admin.id,
    ]);
    const res = await http()
      .post('/api/v1/auth/sign-in')
      .send({ email: admin.email, password: admin.password })
      .expect(200);
    expect(res.body).toMatchObject({ mfaRequired: true, factor: 'email' });
    expect(res.body.devCode).toBe(emailCode(t.outbox().at(-1)!.text));
    const mfaCookie = cookieFrom(res.headers['set-cookie'], 'sc_mfa') ?? '';

    const resent = await http()
      .post('/api/v1/auth/mfa/email-code')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', mfaCookie)
      .expect(200);
    expect(resent.body.devCode).toBe(emailCode(t.outbox().at(-1)!.text));

    await http()
      .post('/api/v1/auth/mfa/verify')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', mfaCookie)
      .send({ code: resent.body.devCode })
      .expect(200);
  });

  it('a non-admin sign-in carries no code', async () => {
    const user = await t.createUser();
    const res = await http()
      .post('/api/v1/auth/sign-in')
      .send({ email: user.email, password: user.password })
      .expect(200);
    expect(res.body.devCode).toBeUndefined();
    expect(res.body.accessToken).toBeDefined();
  });
});
