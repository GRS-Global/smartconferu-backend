import request from 'supertest';
import {
  createTestApp,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

interface Registration {
  payment: string;
  attendance: string | null;
  presenterEmail: string | null;
  presenterName: string | null;
  note: string | null;
  updatedAt: string | null;
}

describe('Payment and attendance of accepted papers', () => {
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
    get: (path: string) =>
      http().get(api(path)).set('Authorization', `Bearer ${token}`),
    post: (path: string, body?: object) =>
      http()
        .post(api(path))
        .set('Authorization', `Bearer ${token}`)
        .send(body ?? {}),
    put: (path: string, body: object) =>
      http().put(api(path)).set('Authorization', `Bearer ${token}`).send(body),
  });

  /** A live conference, its chair, and two papers by `author` (the second with a co-author). */
  async function setup() {
    const chair = await person({ firstName: 'Carla', lastName: 'Chair' });
    const author = await person({ firstName: 'Ada', lastName: 'Author' });
    const outsider = await person();
    const admin = await person();
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
    const submit = async (title: string) =>
      (
        await as(author.token)
          .post(`/conferences/${conferenceId}/submissions`, {
            title,
            abstract: 'An abstract.',
            keywords: ['test'],
            authors: [
              {
                affiliation: 'Test University',
                city: 'Pune',
                country: 'India',
                name: 'Ada Author',
                email: author.email,
                corresponding: true,
              },
              {
                affiliation: 'Test University',
                city: 'Pune',
                country: 'India',
                name: 'Ben Second',
                email: 'Ben.Second@uni.example',
              },
            ],
          })
          .expect(201)
      ).body.id as string;
    const submissionId = await submit('Graph networks for protein folding');
    const otherId = await submit('A second paper');
    const types = await as(chair.token)
      .get(`/conferences/${conferenceId}/decision-types`)
      .expect(200);
    const typeOf = (outcome: string) =>
      (types.body as Array<{ id: string; outcome: string }>).find(
        (d) => d.outcome === outcome,
      )!.id;
    const decide = (id: string, outcome: string) =>
      as(chair.token)
        .post(`/submissions/${id}/decision`, {
          decisionTypeId: typeOf(outcome),
        })
        .expect(200);
    return {
      chair,
      author,
      outsider,
      conferenceId,
      submissionId,
      otherId,
      decide,
    };
  }

  const paid = {
    payment: 'paid',
    attendance: 'physical',
    presenterEmail: 'ben.second@uni.example',
    note: 'Receipt 4411, 250 EUR',
  };

  it('lets a chair record payment and attendance once a paper is accepted', async () => {
    const s = await setup();

    // Not before the paper is accepted.
    const early = await as(s.chair.token)
      .put(`/submissions/${s.submissionId}/registration`, paid)
      .expect(422);
    expect(early.body.message).toMatch(/once the paper is accepted/);
    const pending = await as(s.chair.token)
      .get(`/submissions/${s.submissionId}`)
      .expect(200);
    expect(pending.body.registration).toBeNull();

    // Accepted: "not paid, attendance not known" until the chair records it.
    await s.decide(s.submissionId, 'accept');
    const accepted = await as(s.chair.token)
      .get(`/submissions/${s.submissionId}`)
      .expect(200);
    expect(accepted.body.registration).toEqual({
      payment: 'not_paid',
      attendance: null,
      presenterEmail: null,
      presenterName: null,
      note: null,
      updatedAt: null,
    });

    const saved = await as(s.chair.token)
      .put(`/submissions/${s.submissionId}/registration`, paid)
      .expect(200);
    const registration = saved.body.registration as Registration;
    // The presenter is matched case-insensitively and kept as written on the paper.
    expect(registration).toMatchObject({
      payment: 'paid',
      attendance: 'physical',
      presenterEmail: 'Ben.Second@uni.example',
      presenterName: 'Ben Second',
      note: 'Receipt 4411, 250 EUR',
    });
    expect(registration.updatedAt).toEqual(expect.any(String));

    // Changing it again replaces every field (attendance back to "not known").
    const changed = await as(s.chair.token)
      .put(`/submissions/${s.submissionId}/registration`, {
        payment: 'waived',
        attendance: null,
        presenterEmail: null,
        note: null,
      })
      .expect(200);
    expect(changed.body.registration).toMatchObject({
      payment: 'waived',
      attendance: null,
      presenterEmail: null,
      note: null,
    });

    // No email goes to the authors.
    await t.sendQueuedEmails();
    expect(
      t.outbox().filter((m) => /payment|attendance/i.test(m.subject)),
    ).toEqual([]);

    // The Activity Logs show the change.
    const log = await as(s.chair.token)
      .get(`/conferences/${s.conferenceId}/activity`)
      .expect(200);
    const entries = (
      log.body as Array<{
        module: string;
        description: string;
        previousValue: string | null;
        newValue: string | null;
      }>
    ).filter((e) => e.module === 'Registration');
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      description: 'Recorded payment and attendance for ICX-1.',
      previousValue: 'Not paid · Attendance not known',
      newValue: 'Paid · Physical · Ben.Second@uni.example',
    });
  });

  it('refuses bad values, a presenter who is not an author, and anyone but a chair', async () => {
    const s = await setup();
    await s.decide(s.submissionId, 'accept');
    const path = `/submissions/${s.submissionId}/registration`;

    await as(s.chair.token)
      .put(path, { ...paid, payment: 'half' })
      .expect(400);
    await as(s.chair.token)
      .put(path, { ...paid, attendance: 'hybrid' })
      .expect(400);
    const stranger = await as(s.chair.token)
      .put(path, { ...paid, presenterEmail: 'someone@else.example' })
      .expect(400);
    expect(stranger.body.message).toMatch(/one of the paper/);

    // The author can't mark their own paper as paid; an outsider doesn't even see it.
    await as(s.author.token).put(path, paid).expect(403);
    await as(s.outsider.token).put(path, paid).expect(404);
    const shown = await as(s.chair.token)
      .get(`/submissions/${s.submissionId}`)
      .expect(200);
    expect(shown.body.registration.payment).toBe('not_paid');
  });

  it('shows authors the payment and attendance only once told the paper is accepted, without the note', async () => {
    const s = await setup();
    await s.decide(s.submissionId, 'accept');
    await as(s.chair.token)
      .put(`/submissions/${s.submissionId}/registration`, paid)
      .expect(200);

    const unsent = await as(s.author.token)
      .get(`/submissions/${s.submissionId}`)
      .expect(200);
    expect(unsent.body.registration).toBeNull();

    await as(s.chair.token)
      .post(`/submissions/${s.submissionId}/decision/notify`)
      .expect(200);
    const told = await as(s.author.token)
      .get(`/submissions/${s.submissionId}`)
      .expect(200);
    expect(told.body.registration).toMatchObject({
      payment: 'paid',
      attendance: 'physical',
      presenterName: 'Ben Second',
      note: null,
    });
    const mine = await as(s.author.token).get('/submissions').expect(200);
    expect(
      (mine.body as Array<{ id: string; registration: unknown }>).find(
        (p) => p.id === s.submissionId,
      )?.registration,
    ).toMatchObject({ payment: 'paid' });
  });

  it('keeps the record when the decision changes, hiding it until the paper is accepted again', async () => {
    const s = await setup();
    await s.decide(s.submissionId, 'accept');
    await as(s.chair.token)
      .put(`/submissions/${s.submissionId}/registration`, paid)
      .expect(200);

    await s.decide(s.submissionId, 'reject');
    const rejected = await as(s.chair.token)
      .get(`/submissions/${s.submissionId}`)
      .expect(200);
    expect(rejected.body.registration).toBeNull();
    await as(s.chair.token)
      .put(`/submissions/${s.submissionId}/registration`, paid)
      .expect(422);

    // "Registered" counts as accepted too.
    await s.decide(s.submissionId, 'registered');
    const back = await as(s.chair.token)
      .get(`/submissions/${s.submissionId}`)
      .expect(200);
    expect(back.body.registration).toMatchObject({
      payment: 'paid',
      attendance: 'physical',
    });
  });

  it("lists each paper's registration for the chair's filters, and follows the author's name", async () => {
    const s = await setup();
    await s.decide(s.submissionId, 'accept');
    await s.decide(s.otherId, 'accept');
    await as(s.chair.token)
      .put(`/submissions/${s.submissionId}/registration`, paid)
      .expect(200);
    await as(s.chair.token)
      .put(`/submissions/${s.otherId}/registration`, {
        payment: 'not_paid',
        attendance: 'virtual',
        presenterEmail: s.author.email,
        note: null,
      })
      .expect(200);

    const list = await as(s.chair.token)
      .get(`/conferences/${s.conferenceId}/submissions`)
      .expect(200);
    const byId = Object.fromEntries(
      (list.body as Array<{ id: string; registration: Registration }>).map(
        (p) => [p.id, p.registration],
      ),
    );
    expect(byId[s.submissionId]).toMatchObject({
      payment: 'paid',
      attendance: 'physical',
    });
    expect(byId[s.otherId]).toMatchObject({
      payment: 'not_paid',
      attendance: 'virtual',
      presenterName: 'Ada Author',
    });

    // The presenter is kept by email, so the name shown follows the author list.
    await t.db.query(
      `update submission_authors set name = 'Ada A. Author' where submission_id = $1 and position = 0`,
      [s.otherId],
    );
    const again = await as(s.chair.token)
      .get(`/submissions/${s.otherId}`)
      .expect(200);
    expect(again.body.registration.presenterName).toBe('Ada A. Author');

    // Deleting a paper deletes its registration.
    await as(s.chair.token)
      .post(`/conferences/${s.conferenceId}/submissions/delete`, {
        ids: [s.otherId],
      })
      .expect(200);
    const rows = await t.db.query(
      'select submission_id from submission_registrations',
    );
    expect(rows.rows).toEqual([{ submission_id: s.submissionId }]);
  });
});
