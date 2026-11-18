import request from 'supertest';
import {
  createTestApp,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

describe('Background jobs', () => {
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

  const as = (token: string) => ({
    post: (path: string, body?: object) =>
      http()
        .post(api(path))
        .set('Authorization', `Bearer ${token}`)
        .send(body ?? {}),
    put: (path: string, body: object) =>
      http().put(api(path)).set('Authorization', `Bearer ${token}`).send(body),
  });

  const reminders = async (email: string) =>
    (
      await t.db.query<{ template_key: string }>(
        `select template_key from email_log
          where lower(to_email) = lower($1) and template_key in ('reviewDueSoon', 'reviewLastDay')
          order by created_at`,
        [email],
      )
    ).rows.map((r) => r.template_key);

  const DAY = 86_400_000;
  const now = new Date();
  const dueDay = new Date(now.getTime() + 3 * DAY).toISOString().slice(0, 10);

  /** A paper given to two reviewers, due in three days. */
  async function reviewing() {
    const chair = await person({ firstName: 'Carla', lastName: 'Chair' });
    const author = await person();
    const admin = await t.createUser();
    await t.db.query('update users set is_super_admin = true where id = $1', [
      admin.id,
    ]);
    await t.db.query(
      `insert into user_mfa (user_id, totp_secret, enabled_at) values ($1, 'x', now())`,
      [admin.id],
    );
    const adminToken = await t.tokenFor(admin.id, true);
    const created = await as(chair.token)
      .post('/conferences', {
        acronym: 'ICX 2027',
        title: 'International Conference X 2027',
        startDate: '2027-06-01',
        endDate: '2027-06-03',
      })
      .expect(201);
    const conferenceId = created.body.id as string;
    await as(adminToken)
      .post(`/admin/conferences/${conferenceId}/decision`, { approve: true })
      .expect(204);
    await as(chair.token)
      .post(`/conferences/${conferenceId}/cfp/publish`)
      .expect(200);
    await as(adminToken)
      .post(`/admin/conferences/${conferenceId}/cfp/decision`, {
        approve: true,
      })
      .expect(204);
    const paper = await as(author.token)
      .post(`/conferences/${conferenceId}/submissions`, {
        title: 'A paper',
        abstract: 'An abstract.',
        authors: [{ name: 'A', email: author.email, corresponding: true }],
      })
      .expect(201);
    await t.db.query(
      `update submissions set outcome = 'plagiarism_clear' where id = $1`,
      [paper.body.id],
    );
    const reviewers = [];
    for (const firstName of ['Rae', 'Sam']) {
      const reviewer = await person({ firstName, lastName: 'Viewer' });
      const invited = await as(chair.token)
        .post(`/conferences/${conferenceId}/members`, { email: reviewer.email })
        .expect(201);
      await as(reviewer.token)
        .post(`/invitations/${invited.body.member.id}/accept`)
        .expect(200);
      reviewers.push({
        ...reviewer,
        memberId: invited.body.member.id as string,
      });
    }
    const assigned = await as(chair.token)
      .post(`/submissions/${paper.body.id}/assignments`, {
        memberIds: reviewers.map((r) => r.memberId),
        dueDate: dueDay,
      })
      .expect(200);
    return { reviewers, assignments: assigned.body.assignments };
  }

  it('sends "3 days left" and "last day" once each, only to reviewers still working', async () => {
    const { reviewers, assignments } = await reviewing();
    const [rae, sam] = reviewers;

    const early = await t.runJobs(new Date(now.getTime() - DAY));
    expect(early.reviewReminders?.queued).toBe(0);

    const first = await t.runJobs(now);
    expect(first.reviewReminders).toMatchObject({ remindersDue: 2, queued: 2 });
    // The hourly run doesn't send it again.
    await t.runJobs(new Date(now.getTime() + 3_600_000));
    expect(await reminders(rae.email)).toEqual(['reviewDueSoon']);

    // Sam sends the review; only Rae is reminded on the last day.
    const samAssignment = assignments.find(
      (a: { reviewer: { userId: string } }) => a.reviewer.userId === sam.id,
    );
    await as(sam.token)
      .put(`/assignments/${samAssignment.id}/review`, {
        score: 4,
        submit: true,
      })
      .expect(200);
    await t.runJobs(new Date(now.getTime() + 3 * DAY));
    expect(await reminders(rae.email)).toEqual([
      'reviewDueSoon',
      'reviewLastDay',
    ]);
    expect(await reminders(sam.email)).toEqual(['reviewDueSoon']);

    await t.sendQueuedEmails();
    const last = t
      .outbox()
      .find((m) => m.to === rae.email && /Last day/.test(m.subject));
    expect(last?.text).toContain('ICX-1 · A paper — due');
    const bell = await t.db.query<{ kind: string }>(
      `select kind from notifications where user_id = $1 and kind = 'review_reminder'`,
      [rae.id],
    );
    expect(bell.rows).toHaveLength(2);
  });

  it('deletes sign-in links and sessions that expired over a week ago', async () => {
    const user = await t.createUser();
    await t.db.query(
      `insert into auth_tokens (user_id, email, purpose, token_hash, expires_at) values
        ($1, 'a@x.test', 'verify_email', 'old', now() - interval '8 days'),
        ($1, 'a@x.test', 'verify_email', 'recent', now() - interval '1 day')`,
      [user.id],
    );
    await t.db.query(
      `insert into sessions (user_id, family_id, token_hash, expires_at) values
        ($1, gen_random_uuid(), 'old', now() - interval '8 days'),
        ($1, gen_random_uuid(), 'live', now() + interval '1 day')`,
      [user.id],
    );
    const result = await t.runJobs();
    expect(result.cleanup).toEqual({ authTokens: 1, sessions: 1 });
    const left = await t.db.query<{ token_hash: string }>(
      'select token_hash from sessions where user_id = $1',
      [user.id],
    );
    expect(left.rows.map((r) => r.token_hash)).toEqual(['live']);
  });
});
