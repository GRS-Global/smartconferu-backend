import request from 'supertest';
import {
  createTestApp,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

/** "Take a tour" is shown by itself only once per person and conference, on every device. */
describe('Conference tour', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  afterEach(() => t.reset());

  const http = () => request(t.app.getHttpServer());
  const api = (path: string) => `/api/v1${path}`;

  async function person(): Promise<TestUser & { token: string }> {
    const user = await t.createUser();
    return { ...user, token: await t.tokenFor(user.id) };
  }
  const as = (token: string) => ({
    get: (path: string) =>
      http().get(api(path)).set('Authorization', `Bearer ${token}`),
    post: (path: string) =>
      http().post(api(path)).set('Authorization', `Bearer ${token}`).send({}),
  });

  async function conference(chairToken: string) {
    const created = await as(chairToken).post('/conferences').send({
      acronym: 'TUR 2027',
      title: 'Tour Conference 2027',
      startDate: '2027-06-01',
      endDate: '2027-06-03',
    });
    return created.body.id as string;
  }

  it('starts unseen, is remembered after the first time, and stays remembered', async () => {
    const chair = await person();
    const id = await conference(chair.token);
    const url = `/conferences/${id}/tour`;

    expect((await as(chair.token).get(url).expect(200)).body).toEqual({
      seen: false,
    });

    await as(chair.token).post(`${url}/seen`).expect(204);
    expect((await as(chair.token).get(url).expect(200)).body).toEqual({
      seen: true,
    });

    // Safe to repeat (a second device, a reload): still one row, still seen.
    await as(chair.token).post(`${url}/seen`).expect(204);
    const rows = await t.db.query(
      'select 1 from conference_tour_seen where conference_id = $1 and user_id = $2',
      [id, chair.id],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('is shared by every device of the same account (another session reads the same answer)', async () => {
    const chair = await person();
    const id = await conference(chair.token);
    await as(chair.token).post(`/conferences/${id}/tour/seen`).expect(204);

    const otherDevice = await t.tokenFor(chair.id);
    expect(
      (await as(otherDevice).get(`/conferences/${id}/tour`).expect(200)).body,
    ).toEqual({ seen: true });
  });

  it('is kept per conference: a new conference gets its own first tour', async () => {
    const chair = await person();
    const first = await conference(chair.token);
    await as(chair.token).post(`/conferences/${first}/tour/seen`).expect(204);
    const second = await as(chair.token).post('/conferences').send({
      acronym: 'TWO 2027',
      title: 'Second Conference 2027',
      startDate: '2027-07-01',
      endDate: '2027-07-03',
    });
    expect(
      (await as(chair.token).get(`/conferences/${second.body.id}/tour`)).body,
    ).toEqual({ seen: false });
  });

  it('does not leak a conference to someone who cannot see it', async () => {
    const chair = await person();
    const stranger = await person();
    const id = await conference(chair.token);
    await as(stranger.token).get(`/conferences/${id}/tour`).expect(404);
    await as(stranger.token).post(`/conferences/${id}/tour/seen`).expect(404);
  });
});
