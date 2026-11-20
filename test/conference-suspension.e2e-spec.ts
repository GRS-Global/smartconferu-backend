import request from 'supertest';
import {
  createTestApp,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

/** A Super Admin suspends a conference: read-only for everyone else until reactivated. */
describe('Conference suspension', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  afterEach(() => t.reset());

  const http = () => request(t.app.getHttpServer());
  const api = (path: string) => `/api/v1${path}`;

  async function person(): Promise<TestUser & { token: string }> {
    const user = await t.createUser({ firstName: 'Carla', lastName: 'Chair' });
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
    patch: (path: string, body: object) =>
      http()
        .patch(api(path))
        .set('Authorization', `Bearer ${token}`)
        .send(body),
  });

  async function setup() {
    const chair = await person();
    const admin = await superAdmin();
    const created = await as(chair.token)
      .post('/conferences', {
        acronym: 'ICX 2027',
        title: 'International Conference X 2027',
      })
      .expect(201);
    const id = created.body.id as string;
    await as(admin.token)
      .post(`/admin/conferences/${id}/decision`, { approve: true })
      .expect(204);
    return { chair, admin, id };
  }

  it('blocks every change by the chairs while suspended, and lifts it on reactivation', async () => {
    const { chair, admin, id } = await setup();
    await as(chair.token)
      .patch(`/conferences/${id}`, { about: 'Before' })
      .expect(200);

    await as(admin.token).post(`/admin/conferences/${id}/suspend`).expect(403);
    await as(admin.steppedUp)
      .post(`/admin/conferences/${id}/suspend`, { reason: 'Payment dispute' })
      .expect(204);

    const list = await as(admin.token).get('/admin/conferences').expect(200);
    expect(list.body.find((c: { id: string }) => c.id === id).suspended).toBe(
      true,
    );
    const blocked = await as(chair.token)
      .patch(`/conferences/${id}`, { about: 'During' })
      .expect(403);
    expect(blocked.body.code).toBe('CONFERENCE_SUSPENDED');
    // Reading still works.
    await as(chair.token).get(`/conferences/${id}`).expect(200);
    const { rows } = await t.db.query<{ title: string; body: string }>(
      'select title, body from notifications where user_id = $1',
      [chair.id],
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        title: 'ICX 2027 is suspended',
        body: 'Payment dispute',
      }),
    );

    await as(admin.steppedUp)
      .post(`/admin/conferences/${id}/reactivate`)
      .expect(204);
    await as(chair.token)
      .patch(`/conferences/${id}`, { about: 'After' })
      .expect(200);
  });

  it('only suspends live or archived conferences', async () => {
    const chair = await person();
    const admin = await superAdmin();
    const created = await as(chair.token)
      .post('/conferences', { acronym: 'NEW 1', title: 'Still a request' })
      .expect(201);
    await as(admin.steppedUp)
      .post(`/admin/conferences/${created.body.id}/suspend`)
      .expect(422);
  });
});
