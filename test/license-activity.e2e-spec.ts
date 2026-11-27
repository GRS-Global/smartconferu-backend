import request from 'supertest';
import {
  createTestApp,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

/** The license extension requests (chair → Super Admin) and the chair's Activity Logs. */
describe('License requests and Activity Logs', () => {
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
    patch: (path: string, body: object) =>
      http()
        .patch(api(path))
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    delete: (path: string) =>
      http().delete(api(path)).set('Authorization', `Bearer ${token}`),
  });

  async function setup() {
    const chair = await person({ firstName: 'Carla', lastName: 'Chair' });
    const author = await person({ firstName: 'Ada', lastName: 'Author' });
    const reviewer = await person({ firstName: 'Rae', lastName: 'Viewer' });
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
    await as(chair.token).post(`/conferences/${id}/cfp/publish`).expect(200);
    await as(admin.token)
      .post(`/admin/conferences/${id}/cfp/decision`, { approve: true })
      .expect(204);
    return { chair, author, reviewer, admin, id };
  }

  const bells = async (userId: string, kind: string) =>
    (
      await t.db.query(
        'select 1 from notifications where user_id = $1 and kind = $2',
        [userId, kind],
      )
    ).rows.length;

  describe('license extension requests', () => {
    it('lets a chair ask, a Super Admin answer, and the license date move', async () => {
      const s = await setup();
      const url = `/conferences/${s.id}/license-request`;

      // Nothing asked yet.
      const none = await as(s.chair.token).get(url).expect(200);
      expect(none.body).toEqual({});

      // The date has to be after the current license end (30 days from creation) and after today.
      await as(s.chair.token)
        .post(url, { requestedDate: '2001-01-01' })
        .expect(422);
      await as(s.author.token)
        .post(url, { requestedDate: '2099-01-01' })
        .expect(404);
      await as(s.chair.token).post(url, { requestedDate: 'soon' }).expect(400);

      const asked = await as(s.chair.token)
        .post(url, { requestedDate: '2099-01-01', reason: 'The event moved.' })
        .expect(200);
      expect(asked.body).toMatchObject({
        status: 'pending',
        requestedDate: '2099-01-01',
        reason: 'The event moved.',
      });
      // One at a time.
      await as(s.chair.token)
        .post(url, { requestedDate: '2099-02-01' })
        .expect(409);
      expect(await bells(s.admin.id, 'license_request')).toBe(1);
      // The Super Admin gets an email as well as the bell.
      await t.sendQueuedEmails();
      expect(
        t
          .outbox()
          .filter(
            (m) =>
              m.to === s.admin.email &&
              /License extension requested/.test(m.subject),
          ),
      ).toHaveLength(1);
      t.outbox().length = 0;
      const latest = await as(s.chair.token).get(url).expect(200);
      expect(latest.body.status).toBe('pending');

      // Only a Super Admin sees and answers the list.
      await as(s.chair.token).get('/admin/license-requests').expect(403);
      const list = await as(s.admin.token)
        .get('/admin/license-requests')
        .expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({
        conferenceAcronym: 'ICX 2027',
        requestedByName: 'Carla Chair',
        currentExpiry: null,
      });
      const requestId = list.body[0].id as string;

      // Declined with a reason: the chair is told and may ask again.
      await as(s.chair.token)
        .post(`/admin/license-requests/${requestId}/decision`, {
          approve: false,
        })
        .expect(403);
      await as(s.admin.token)
        .post(`/admin/license-requests/${requestId}/decision`, {
          approve: false,
          reason: 'Not yet.',
        })
        .expect(204);
      expect(await bells(s.chair.id, 'license_decision')).toBe(1);
      await t.sendQueuedEmails();
      const declinedMail = t.outbox().find((m) => m.to === s.chair.email);
      expect(declinedMail?.subject).toMatch(
        /license extension of ICX 2027 was not approved/,
      );
      expect(declinedMail?.text).toMatch(/Not yet./);
      t.outbox().length = 0;
      const declined = await as(s.chair.token).get(url).expect(200);
      expect(declined.body).toMatchObject({
        status: 'declined',
        decisionReason: 'Not yet.',
      });
      // A decided request cannot be answered again.
      await as(s.admin.token)
        .post(`/admin/license-requests/${requestId}/decision`, {
          approve: true,
        })
        .expect(422);

      // A new request, approved for another date than asked.
      const again = await as(s.chair.token)
        .post(url, { requestedDate: '2099-03-01' })
        .expect(200);
      await as(s.admin.token)
        .post(`/admin/license-requests/${again.body.id}/decision`, {
          approve: true,
          newExpiry: '2099-02-15',
        })
        .expect(204);
      const approved = await as(s.chair.token).get(url).expect(200);
      expect(approved.body).toMatchObject({
        status: 'approved',
        newExpiry: '2099-02-15',
      });
      const conference = await as(s.chair.token)
        .get(`/conferences/${s.id}`)
        .expect(200);
      expect(conference.body.details.licenseExpiry).toBe('2099-02-15');
      expect(await bells(s.chair.id, 'license_decision')).toBe(2);
      await t.sendQueuedEmails();
      const approvedMail = t.outbox().find((m) => m.to === s.chair.email);
      expect(approvedMail?.subject).toMatch(/license of ICX 2027 was extended/);
      expect(approvedMail?.text).toMatch(/2099-02-15/);

      // The next request has to start after the new license end.
      await as(s.chair.token)
        .post(url, { requestedDate: '2099-02-10' })
        .expect(422);
      await as(s.chair.token)
        .post(url, { requestedDate: '2099-04-01' })
        .expect(200);
    });

    it('lets the chair take a waiting request back', async () => {
      const s = await setup();
      const url = `/conferences/${s.id}/license-request`;
      await as(s.chair.token).delete(url).expect(422);
      await as(s.chair.token)
        .post(url, { requestedDate: '2099-01-01' })
        .expect(200);
      await as(s.chair.token).delete(url).expect(204);
      const after = await as(s.chair.token).get(url).expect(200);
      expect(after.body.status).toBe('withdrawn');
      const list = await as(s.admin.token)
        .get('/admin/license-requests')
        .expect(200);
      expect(list.body).toHaveLength(0);
      // and can ask again
      await as(s.chair.token)
        .post(url, { requestedDate: '2099-01-01' })
        .expect(200);
    });
  });

  describe('Activity Logs', () => {
    it('lists what was done in the conference for its chairs, newest first', async () => {
      const s = await setup();
      await as(s.chair.token)
        .patch(`/conferences/${s.id}`, { about: 'A conference about X.' })
        .expect(200);
      const paper = await as(s.author.token)
        .post(`/conferences/${s.id}/submissions`, {
          title: 'Graph networks for protein folding',
          abstract: 'We show that graph networks fold proteins.',
          authors: [
            { name: 'Ada Author', email: s.author.email, corresponding: true },
          ],
        })
        .expect(201);
      await t.db.query(
        `update submissions set outcome = 'plagiarism_clear' where id = $1`,
        [paper.body.id],
      );
      const member = await as(s.chair.token)
        .post(`/conferences/${s.id}/members`, { email: s.reviewer.email })
        .expect(201);
      await as(s.reviewer.token)
        .post(`/invitations/${member.body.member.id}/accept`)
        .expect(200);
      const given = await as(s.chair.token)
        .post(`/submissions/${paper.body.id}/assignments`, {
          memberIds: [member.body.member.id],
          dueDate: '2099-04-30',
        })
        .expect(200);
      await as(s.chair.token)
        .post(`/assignments/${given.body.assignments[0].id}/remind`, {})
        .expect(204);

      const log = await as(s.chair.token)
        .get(`/conferences/${s.id}/activity`)
        .expect(200);
      const entries = log.body as Array<{
        action: string;
        module: string;
        description: string;
        actorName: string;
        actorRole: string;
        reviewerName: string | null;
      }>;
      const find = (re: RegExp) => entries.find((e) => re.test(e.description));
      expect(find(/Updated the conference details/)).toMatchObject({
        module: 'Conference Details',
        actorName: 'Carla Chair',
        actorRole: 'chair',
      });
      expect(find(/Submitted ICX-1\./)).toMatchObject({
        module: 'Submissions',
        action: 'Submitted',
        actorName: 'Ada Author',
        actorRole: 'author',
      });
      expect(find(/reviewer assigned to ICX-1/)).toMatchObject({
        module: 'Peer Review',
        action: 'Assigned',
        reviewerName: 'Rae Viewer',
        actorRole: 'chair',
      });
      expect(find(/Reminded a reviewer about ICX-1/)).toMatchObject({
        action: 'Sent',
      });
      expect(find(/Invited .*Viewer to the committee as/i)).toMatchObject({
        module: 'Committee',
        actorRole: 'chair',
      });
      expect(find(/invitation to the committee was accepted/)).toMatchObject({
        actorRole: 'reviewer',
      });
      // sign-ins and the like never appear; the newest comes first
      expect(entries.every((e) => !/sign.?in/i.test(e.description))).toBe(true);
      expect(entries[0].description).toMatch(/Reminded a reviewer/);

      // Only chairs read it.
      await as(s.author.token).get(`/conferences/${s.id}/activity`).expect(403);
      await as(s.reviewer.token)
        .get(`/conferences/${s.id}/activity`)
        .expect(403);
    });

    it("gives a reviewer and an author their own log, and nobody else's", async () => {
      const s = await setup();
      const other = await person({ firstName: 'Olly', lastName: 'Other' });
      const paper = await as(s.author.token)
        .post(`/conferences/${s.id}/submissions`, {
          title: 'Graph networks for protein folding',
          abstract: 'We show that graph networks fold proteins.',
          authors: [
            { name: 'Ada Author', email: s.author.email, corresponding: true },
          ],
        })
        .expect(201);
      await t.db.query(
        `update submissions set outcome = 'plagiarism_clear' where id = $1`,
        [paper.body.id],
      );
      const members: Record<string, string> = {};
      for (const who of [s.reviewer, other]) {
        const m = await as(s.chair.token)
          .post(`/conferences/${s.id}/members`, { email: who.email })
          .expect(201);
        await as(who.token)
          .post(`/invitations/${m.body.member.id}/accept`)
          .expect(200);
        members[who.id] = m.body.member.id;
      }
      const given = await as(s.chair.token)
        .post(`/submissions/${paper.body.id}/assignments`, {
          memberIds: [members[s.reviewer.id]],
          dueDate: '2099-04-30',
        })
        .expect(200);
      const aid = given.body.assignments[0].id as string;
      await as(s.chair.token)
        .post(`/assignments/${aid}/remind`, {})
        .expect(204);
      await as(s.reviewer.token)
        .post(`/assignments/${aid}/respond`, { accept: true })
        .expect(200);
      await as(s.reviewer.token)
        .post(`/assignments/${aid}/extension-request`, { date: '2099-05-30' })
        .expect(200);
      await as(s.chair.token)
        .post(`/submissions/${paper.body.id}/fix-request`, {
          issue: 'Fonts are too small.',
          fixBy: '2099-03-01',
        })
        .expect(200);

      const mine = async (token: string, role: string) =>
        (
          await as(token)
            .get(`/conferences/${s.id}/my-activity?role=${role}`)
            .expect(200)
        ).body as Array<{
          description: string;
          actorName: string;
          actorRole: string;
          module: string;
          reviewerName: string | null;
        }>;
      const rev = await mine(s.reviewer.token, 'reviewer');
      const text = rev.map((e) => e.description).join(' | ');
      expect(text).toMatch(/You were assigned as a reviewer for ICX-1/);
      expect(text).toMatch(/The chair sent you a reminder about ICX-1/);
      expect(text).toMatch(/You accepted ICX-1/);
      expect(text).toMatch(/You asked for more time on ICX-1/);
      expect(rev.every((e) => e.module === 'Peer Review')).toBe(true);
      expect(rev.every((e) => e.reviewerName === null)).toBe(true);
      expect(
        rev.find((e) => /sent you a reminder/.test(e.description)),
      ).toMatchObject({ actorName: 'The chair', actorRole: 'chair' });
      expect(rev.find((e) => /You accepted/.test(e.description))).toMatchObject(
        {
          actorRole: 'reviewer',
        },
      );
      // another reviewer, who was not given the paper, sees none of it
      expect(await mine(other.token, 'reviewer')).toEqual([]);

      // the author: submissions only, with what the chair did to the paper
      const auth = await mine(s.author.token, 'author');
      const atext = auth.map((e) => e.description).join(' | ');
      expect(atext).toMatch(/Submitted ICX-1/);
      expect(atext).toMatch(/The chair asked you to fix something in ICX-1/);
      expect(atext).not.toMatch(/review/i);
      expect(auth.every((e) => e.module === 'Submissions')).toBe(true);
      // the reviewer is no author of it
      expect(await mine(s.reviewer.token, 'author')).toEqual([]);
      // someone with no part in the conference is refused
      const stranger = await person();
      await as(stranger.token)
        .get(`/conferences/${s.id}/my-activity`)
        .expect(404);
    });
  });
});
