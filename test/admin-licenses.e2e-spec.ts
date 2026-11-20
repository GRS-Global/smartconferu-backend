import request from 'supertest';
import {
  createTestApp,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

/** The Super Admin's view of licenses: list fields and "Extend license" on a conference's page. */
describe('Admin › conference licenses', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  afterEach(() => t.reset());

  const http = () => request(t.app.getHttpServer());
  const api = (path: string) => `/api/v1${path}`;

  async function person(
    fields: Parameters<TestApp['createUser']>[0] = {},
  ): Promise<TestUser & { token: string }> {
    const user = await t.createUser(fields);
    return { ...user, token: await t.tokenFor(user.id) };
  }

  async function superAdmin() {
    const user = await t.createUser({ firstName: 'Super', lastName: 'Admin' });
    await t.db.query('update users set is_super_admin = true where id = $1', [
      user.id,
    ]);
    await t.db.query(
      `insert into user_mfa (user_id, totp_secret, enabled_at) values ($1, 'x', now())`,
      [user.id],
    );
    return {
      ...user,
      token: await t.tokenFor(user.id, true),
      steppedUp: await t.steppedUpToken(user.id),
    };
  }

  const as = (token: string) => ({
    get: (path: string) =>
      http().get(api(path)).set('Authorization', `Bearer ${token}`),
    post: (path: string, body?: object) =>
      http()
        .post(api(path))
        .set('Authorization', `Bearer ${token}`)
        .send(body ?? {}),
  });

  const inDays = (n: number) =>
    new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  async function setup() {
    const chair = await person({ firstName: 'Carla', lastName: 'Chair' });
    const admin = await superAdmin();
    const created = await as(chair.token)
      .post('/conferences', {
        acronym: 'ICX 2027',
        title: 'International Conference X 2027',
        startDate: '2027-06-01',
        endDate: '2027-06-03',
      })
      .expect(201);
    const id = created.body.id as string;
    await as(admin.token)
      .post(`/admin/conferences/${id}/decision`, { approve: true })
      .expect(204);
    return { chair, admin, id };
  }

  it('lists each conference with its papers, license end and trial state', async () => {
    const { admin, id } = await setup();
    const list = await as(admin.token).get('/admin/conferences').expect(200);
    const row = list.body.find((c: { id: string }) => c.id === id);
    expect(row).toMatchObject({ papers: 0, onTrial: true });
    expect(row.licenseExpiry).toBe(inDays(30));
  });

  it('"Extend license" moves the date, ends the trial and tells the chairs', async () => {
    const { admin, chair, id } = await setup();
    const until = inDays(200);
    const ask = await as(admin.token)
      .post(`/admin/conferences/${id}/license`, { expiry: until })
      .expect(403);
    expect(ask.body.code).toBe('AUTH_STEP_UP_REQUIRED');
    await as(admin.steppedUp)
      .post(`/admin/conferences/${id}/license`, { expiry: until })
      .expect(204);

    const list = await as(admin.token).get('/admin/conferences').expect(200);
    expect(list.body.find((c: { id: string }) => c.id === id)).toMatchObject({
      licenseExpiry: until,
      onTrial: false,
    });
    const { rows } = await t.db.query<{ title: string }>(
      'select title from notifications where user_id = $1',
      [chair.id],
    );
    expect(rows.map((r) => r.title)).toContain(`License extended to ${until}`);
    const audit = await t.db.query<{ data: { newExpiry: string } }>(
      `select data from audit_log where action = 'conference.license_extended' and entity_id = $1`,
      [id],
    );
    expect(audit.rows[0].data.newExpiry).toBe(until);
  });

  it('only moves the license forward, and only for super admins', async () => {
    const { admin, chair, id } = await setup();
    const early = await as(admin.steppedUp)
      .post(`/admin/conferences/${id}/license`, { expiry: inDays(10) })
      .expect(422);
    expect(early.body.message).toMatch(/Pick a date after/);
    await as(admin.steppedUp)
      .post(`/admin/conferences/${id}/license`, { expiry: 'soon' })
      .expect(400);
    await as(chair.token)
      .post(`/admin/conferences/${id}/license`, { expiry: inDays(200) })
      .expect(403);
  });
});
