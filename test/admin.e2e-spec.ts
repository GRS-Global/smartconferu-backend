import request from 'supertest';
import {
  createTestApp,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

describe('The super-admin console', () => {
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
    return { ...user, token: await t.tokenFor(user.id, true) };
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

  async function platform() {
    const admin = await superAdmin();
    const chair = await person({
      firstName: 'Carla',
      lastName: 'Chair',
      email: 'carla@uni.example',
    });
    const author = await person({ firstName: 'Ada', lastName: 'Author' });
    const created = await as(chair.token)
      .post('/conferences', {
        acronym: 'ICX 2027',
        title: 'International Conference X 2027',
        startDate: '2027-06-01',
        endDate: '2027-06-03',
      })
      .expect(201);
    const conferenceId = created.body.id as string;
    await as(admin.token)
      .post(`/admin/conferences/${conferenceId}/decision`, { approve: true })
      .expect(204);
    await as(chair.token)
      .post(`/conferences/${conferenceId}/cfp/publish`)
      .expect(200);
    await as(admin.token)
      .post(`/admin/conferences/${conferenceId}/cfp/decision`, {
        approve: true,
      })
      .expect(204);
    const paper = await as(author.token)
      .post(`/conferences/${conferenceId}/submissions`, {
        title: 'A paper',
        abstract: 'An abstract.',
        authors: [
          { name: 'Ada Author', email: author.email, corresponding: true },
        ],
      })
      .expect(201);
    return {
      admin,
      chair,
      author,
      conferenceId,
      submissionId: paper.body.id as string,
    };
  }

  it('shows platform numbers', async () => {
    const { admin } = await platform();
    const res = await as(admin.token).get('/admin/stats').expect(200);
    expect(res.body).toMatchObject({
      conferences: { active: 1, pendingApproval: 0 },
      papers: { submitted: 1 },
      users: { total: 3, superAdmins: 1 },
    });
  });

  it('lists and searches users with their roles', async () => {
    const { admin, chair, author } = await platform();
    const all = await as(admin.token).get('/admin/users').expect(200);
    const roles = Object.fromEntries(
      all.body.data.map((u: { id: string; roles: string[] }) => [
        u.id,
        u.roles,
      ]),
    );
    expect(roles[chair.id]).toEqual(['chair']);
    expect(roles[author.id]).toEqual(['author']);
    expect(roles[admin.id]).toEqual(['super_admin']);

    const found = await as(admin.token)
      .get('/admin/users?search=uni.example')
      .expect(200);
    expect(found.body.data.map((u: { id: string }) => u.id)).toEqual([
      chair.id,
    ]);
    const paged = await as(admin.token).get('/admin/users?limit=2').expect(200);
    expect(paged.body.data).toHaveLength(2);
    const rest = await as(admin.token)
      .get(`/admin/users?limit=2&cursor=${paged.body.nextCursor}`)
      .expect(200);
    expect(rest.body.data).toHaveLength(1);
    expect(rest.body.nextCursor).toBeNull();
  });

  it('shows recent activity and a conference’s review health', async () => {
    const { admin, conferenceId } = await platform();
    const activity = await as(admin.token)
      .get('/admin/activity?action=submission.')
      .expect(200);
    expect(activity.body.data[0]).toMatchObject({
      action: 'submission.created',
      actor: { name: 'Ada Author' },
    });
    // The Audit Log's filters: one conference, a date range, words.
    const about = await as(admin.token)
      .get(`/admin/activity?entityId=${conferenceId}`)
      .expect(200);
    expect(about.body.data.length).toBeGreaterThan(0);
    expect(
      about.body.data.every(
        (a: { entityId: string }) => a.entityId === conferenceId,
      ),
    ).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    const inRange = await as(admin.token)
      .get(`/admin/activity?from=${today}&to=${today}`)
      .expect(200);
    expect(inRange.body.data.length).toBeGreaterThan(0);
    const before = await as(admin.token)
      .get('/admin/activity?to=2000-01-01')
      .expect(200);
    expect(before.body.data).toEqual([]);
    const words = await as(admin.token)
      .get('/admin/activity?q=ada%20author')
      .expect(200);
    expect(words.body.data[0].actor.name).toBe('Ada Author');
    const odd = await as(admin.token)
      .get('/admin/activity?q=100%25_x')
      .expect(200);
    expect(odd.body.data).toEqual([]);
    await as(admin.token).get('/admin/activity?from=yesterday').expect(400);

    // The dashboard chart: this month has the paper submitted above.
    const year = new Date().getUTCFullYear();
    const chart = await as(admin.token)
      .get(`/admin/stats/activity?year=${year}`)
      .expect(200);
    expect(chart.body.year).toBe(year);
    expect(chart.body.years[0]).toBe(year);
    expect(chart.body.months).toHaveLength(12);
    const thisMonth = chart.body.months[new Date().getUTCMonth()];
    expect(thisMonth.submissions).toBeGreaterThanOrEqual(1);
    const empty = await as(admin.token)
      .get('/admin/stats/activity?year=2001')
      .expect(200);
    expect(
      empty.body.months.every(
        (m: { submissions: number; reviews: number }) =>
          m.submissions === 0 && m.reviews === 0,
      ),
    ).toBe(true);
    await as(admin.token).get('/admin/stats/activity?year=1900').expect(400);

    const papers = await as(admin.token)
      .get(`/admin/conferences/${conferenceId}/papers`)
      .expect(200);
    expect(papers.body).toEqual([
      expect.objectContaining({
        paperId: 'ICX-1',
        stage: 'upload',
        reviewsIn: 0,
        reviewers: [],
        authors: [expect.objectContaining({ name: 'Ada Author' })],
      }),
    ]);
  });

  it('is only for super admins in a two-step session', async () => {
    const { chair, admin } = await platform();
    await as(chair.token).get('/admin/stats').expect(403);
    const noMfa = await t.tokenFor(admin.id, false);
    await as(noMfa).get('/admin/users').expect(403);
  });
});
