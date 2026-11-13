import request from 'supertest';
import {
  createTestApp,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

describe('Conferences, CFP and team', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  afterEach(() => t.reset());

  const http = () => request(t.app.getHttpServer());
  const api = (path: string) => `/api/v1${path}`;

  /** A user and a ready access token. */
  async function person(
    fields: Parameters<TestApp['createUser']>[0] = {},
  ): Promise<TestUser & { token: string }> {
    const user = await t.createUser(fields);
    return { ...user, token: await t.tokenFor(user.id) };
  }

  /** A super admin with two-step verification on, signed in with it. */
  async function superAdmin(): Promise<TestUser & { token: string }> {
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
    put: (path: string, body: object) =>
      http().put(api(path)).set('Authorization', `Bearer ${token}`).send(body),
    delete: (path: string) =>
      http().delete(api(path)).set('Authorization', `Bearer ${token}`),
  });

  const request_ = {
    acronym: 'ISBM 2027',
    title: 'Information Systems for Business Management 2027',
    mode: 'hybrid',
    city: 'London',
    country: 'United Kingdom',
    startDate: '2027-03-15',
    endDate: '2027-03-17',
    details: { topics: ['information systems'] },
  };

  /** A conference requested by `chair` and approved by a super admin. */
  async function liveConference(chair: { token: string }) {
    const created = await as(chair.token)
      .post('/conferences', request_)
      .expect(201);
    const admin = await superAdmin();
    await as(admin.token)
      .post(`/admin/conferences/${created.body.id}/decision`, { approve: true })
      .expect(204);
    return created.body.id as string;
  }

  const notificationsOf = async (userId: string) =>
    (
      await t.db.query<{ kind: string; title: string }>(
        'select kind, title from notifications where user_id = $1 order by created_at',
        [userId],
      )
    ).rows;

  describe('requesting and approving a conference', () => {
    it('creates a request with its chair, decision labels and an empty CFP', async () => {
      const chair = await person();
      const admin = await superAdmin();
      const res = await as(chair.token)
        .post('/conferences', request_)
        .expect(201);
      expect(res.body).toMatchObject({
        slug: 'isbm2027',
        acronym: 'ISBM 2027',
        status: 'pending_approval',
        cfpStatus: 'draft',
        myRoles: ['chair'],
        details: { topics: ['information systems'] },
        createdBy: chair.id,
      });

      const { rows: labels } = await t.db.query(
        'select outcome from decision_types where conference_id = $1 order by position',
        [res.body.id],
      );
      expect(labels).toHaveLength(8);
      expect(await notificationsOf(admin.id)).toEqual([
        { kind: 'conference_request', title: 'New conference request' },
      ]);

      const mine = await as(chair.token).get('/conferences').expect(200);
      expect(mine.body.conferences).toEqual([]);
      expect(mine.body.requests.map((c: { id: string }) => c.id)).toEqual([
        res.body.id,
      ]);
    });

    it('gives a taken acronym the next free URL id', async () => {
      const chair = await person();
      await as(chair.token).post('/conferences', request_).expect(201);
      const second = await as(chair.token)
        .post('/conferences', request_)
        .expect(201);
      expect(second.body.slug).toBe('isbm2027-2');
    });

    it('validates the request', async () => {
      const chair = await person();
      const res = await as(chair.token)
        .post('/conferences', {
          ...request_,
          mode: 'on the moon',
          endDate: '2027-03-01',
        })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      await as(chair.token)
        .post('/conferences', { ...request_, endDate: '2027-03-01' })
        .expect(400);
    });

    it('approval makes it live, copies the email templates and tells the chair', async () => {
      const chair = await person();
      await t.db.query(
        `insert into email_templates (key, label, subject, body) values ('welcome', 'Welcome', 'Hi', 'Hello')
         on conflict (key) do nothing`,
      );
      const id = await liveConference(chair);

      const res = await as(chair.token).get(`/conferences/${id}`).expect(200);
      expect(res.body.status).toBe('active');
      const { rows } = await t.db.query<{ key: string }>(
        'select key from conference_email_templates where conference_id = $1',
        [id],
      );
      expect(rows.map((r) => r.key)).toContain('welcome');
      expect(await notificationsOf(chair.id)).toContainEqual({
        kind: 'conference_decision',
        title: 'Conference approved',
      });

      const mine = await as(chair.token).get('/conferences').expect(200);
      expect(mine.body.conferences.map((c: { id: string }) => c.id)).toEqual([
        id,
      ]);
    });

    it('a decided request cannot be decided again', async () => {
      const chair = await person();
      const id = await liveConference(chair);
      const admin = await superAdmin();
      const res = await as(admin.token)
        .post(`/admin/conferences/${id}/decision`, { approve: false })
        .expect(422);
      expect(res.body.code).toBe('BUSINESS_RULE');
    });

    it('only a super admin in a verified session decides', async () => {
      const chair = await person();
      const created = await as(chair.token)
        .post('/conferences', request_)
        .expect(201);
      await as(chair.token)
        .post(`/admin/conferences/${created.body.id}/decision`, {
          approve: true,
        })
        .expect(403);

      const admin = await superAdmin();
      const withoutMfa = await t.tokenFor(admin.id, false);
      const res = await as(withoutMfa).get('/admin/conferences').expect(403);
      expect(res.body.code).toBe('AUTH_MFA_REQUIRED');

      const list = await as(admin.token).get('/admin/conferences').expect(200);
      expect(list.body[0].requester).toMatchObject({ id: chair.id });
    });
  });

  describe('who sees and changes a conference', () => {
    it('hides it from outsiders (404, not 403)', async () => {
      const chair = await person();
      const outsider = await person();
      const id = await liveConference(chair);
      const res = await as(outsider.token)
        .get(`/conferences/${id}`)
        .expect(404);
      expect(res.body.code).toBe('NOT_FOUND');
      await as(outsider.token)
        .patch(`/conferences/${id}`, { title: 'Hijacked title' })
        .expect(404);
    });

    it('lets chairs edit details and merges `details`', async () => {
      const chair = await person();
      const id = await liveConference(chair);
      const res = await as(chair.token)
        .patch(`/conferences/${id}`, {
          title: 'A better title',
          submissionDeadline: '2027-01-31T23:59:59Z',
          details: { organizer: 'GR Conferences' },
        })
        .expect(200);
      expect(res.body).toMatchObject({
        title: 'A better title',
        submissionDeadline: '2027-01-31T23:59:59.000Z',
        details: {
          topics: ['information systems'],
          organizer: 'GR Conferences',
        },
      });
    });

    it('shows settings to chairs only and keeps each chair’s setup progress', async () => {
      const chair = await person();
      const id = await liveConference(chair);
      await as(chair.token)
        .patch(`/conferences/${id}/settings`, {
          settings: { reviewTimeline: { days: 21 } },
        })
        .expect(200);
      await as(chair.token)
        .put(`/conferences/${id}/setup-progress`, { progress: { step: 3 } })
        .expect(204);
      const res = await as(chair.token).get(`/conferences/${id}`).expect(200);
      expect(res.body.settings).toEqual({
        reviewTimeline: { days: 21 },
        setupTour: { [chair.id]: { step: 3 } },
      });

      // A reviewer sees the conference but not its settings, and can't change them.
      const reviewer = await person();
      await t.db.query(
        `insert into conference_members (conference_id, user_id, role, status) values ($1, $2, 'reviewer', 'active')`,
        [id, reviewer.id],
      );
      const seen = await as(reviewer.token)
        .get(`/conferences/${id}`)
        .expect(200);
      expect(seen.body.settings).toBeNull();
      expect(seen.body.myRoles).toEqual(['reviewer']);
      await as(reviewer.token)
        .patch(`/conferences/${id}/settings`, { settings: { x: 1 } })
        .expect(403);
    });
  });

  describe('archiving and deletion', () => {
    it('runs archive → deletion request → super admin approval → undelete', async () => {
      const chair = await person();
      const id = await liveConference(chair);
      const admin = await superAdmin();

      // Only an archived conference can be deleted.
      await as(chair.token)
        .post(`/conferences/${id}/deletion-request`, { reason: 'Duplicate' })
        .expect(422);
      await as(chair.token).post(`/conferences/${id}/archive`).expect(200);
      await as(chair.token).post(`/conferences/${id}/archive`).expect(422);

      const asked = await as(chair.token)
        .post(`/conferences/${id}/deletion-request`, { reason: 'Duplicate' })
        .expect(200);
      expect(asked.body.deletionRequest).toMatchObject({
        status: 'pending',
        reason: 'Duplicate',
      });
      await as(chair.token)
        .post(`/conferences/${id}/deletion-request`, { reason: 'Again' })
        .expect(409);

      const requests = await as(admin.token)
        .get('/admin/deletion-requests?status=pending')
        .expect(200);
      expect(requests.body).toHaveLength(1);
      await as(admin.token)
        .post(`/admin/deletion-requests/${requests.body[0].id}/decision`, {
          approve: true,
        })
        .expect(204);

      // Gone for the chair…
      await as(chair.token).get(`/conferences/${id}`).expect(404);
      const mine = await as(chair.token).get('/conferences').expect(200);
      expect(mine.body.conferences).toEqual([]);

      // …until the super admin brings it back, archived.
      await as(admin.token)
        .post(`/admin/conferences/${id}/undelete`)
        .expect(204);
      const back = await as(chair.token).get(`/conferences/${id}`).expect(200);
      expect(back.body.status).toBe('archived');
    });

    it('restoring takes back a pending deletion request', async () => {
      const chair = await person();
      const id = await liveConference(chair);
      await as(chair.token).post(`/conferences/${id}/archive`).expect(200);
      await as(chair.token)
        .post(`/conferences/${id}/deletion-request`, { reason: 'Old' })
        .expect(200);
      const res = await as(chair.token)
        .post(`/conferences/${id}/restore`)
        .expect(200);
      expect(res.body.status).toBe('active');
      const { rows } = await t.db.query(
        'select status from conference_deletion_requests where conference_id = $1',
        [id],
      );
      expect(rows).toEqual([{ status: 'cancelled' }]);
    });
  });

  describe('Call for Papers and the public pages', () => {
    it('can only be published once the conference is approved', async () => {
      const chair = await person();
      const created = await as(chair.token)
        .post('/conferences', request_)
        .expect(201);
      await as(chair.token)
        .post(`/conferences/${created.body.id}/cfp/publish`)
        .expect(422);
    });

    it('publishes, appears in the directory, then closes', async () => {
      const chair = await person();
      const id = await liveConference(chair);

      await as(chair.token)
        .patch(`/conferences/${id}/cfp`, {
          content: { intro: 'Submit your papers' },
          theme: { color: '#2E86DE' },
        })
        .expect(200);

      // A draft CFP is not public.
      let page = await http()
        .get(api('/public/conferences/isbm2027'))
        .expect(200);
      expect(page.body.cfpStatus).toBe('draft');
      let directory = await http().get(api('/public/cfps')).expect(200);
      expect(directory.body).toEqual([]);

      const published = await as(chair.token)
        .post(`/conferences/${id}/cfp/publish`)
        .expect(200);
      expect(published.body).toMatchObject({
        status: 'published',
        content: { intro: 'Submit your papers' },
      });
      page = await http().get(api('/public/conferences/isbm2027')).expect(200);
      expect(page.body).toMatchObject({
        slug: 'isbm2027',
        cfpStatus: 'published',
      });
      expect(page.body.settings).toBeUndefined();
      directory = await http().get(api('/public/cfps')).expect(200);
      expect(directory.body.map((c: { id: string }) => c.id)).toEqual([id]);

      await as(chair.token).post(`/conferences/${id}/cfp/close`).expect(200);
      await as(chair.token).post(`/conferences/${id}/cfp/close`).expect(422);
      directory = await http().get(api('/public/cfps')).expect(200);
      expect(directory.body).toEqual([]);
    });

    it('answers an archived conference’s link with a notice, others with 404', async () => {
      const chair = await person();
      const id = await liveConference(chair);
      await as(chair.token).post(`/conferences/${id}/archive`).expect(200);
      const res = await http()
        .get(api('/public/conferences/isbm2027'))
        .expect(200);
      expect(res.body).toEqual({
        status: 'archived',
        acronym: 'ISBM 2027',
        title: request_.title,
      });
      await http().get(api('/public/conferences/nope')).expect(404);
    });

    it('lets a CFP manager edit and publish, but not a reviewer', async () => {
      const chair = await person();
      const id = await liveConference(chair);
      const manager = await person();
      const reviewer = await person();
      await t.db.query(
        `insert into conference_members (conference_id, user_id, role, status) values
         ($1, $2, 'cfp_manager', 'active'), ($1, $3, 'reviewer', 'active')`,
        [id, manager.id, reviewer.id],
      );
      await as(manager.token)
        .post(`/conferences/${id}/cfp/publish`)
        .expect(200);
      await as(reviewer.token)
        .patch(`/conferences/${id}/cfp`, { content: {} })
        .expect(403);
      // The team reads the CFP in any state.
      await as(reviewer.token).get(`/conferences/${id}/cfp`).expect(200);
    });
  });

  describe('the team and invitations', () => {
    it('invites someone with an account, who accepts', async () => {
      const chair = await person({ firstName: 'Chair', lastName: 'Person' });
      const id = await liveConference(chair);
      const reviewer = await person({ firstName: 'Rae', lastName: 'Viewer' });

      const invited = await as(chair.token)
        .post(`/conferences/${id}/members`, {
          email: reviewer.email.toUpperCase(),
          expertise: ['databases'],
          maxPapers: 5,
        })
        .expect(201);
      expect(invited.body).toMatchObject({
        created: true,
        member: {
          role: 'reviewer',
          status: 'invited',
          userId: reviewer.id,
          name: 'Rae Viewer',
          expertise: ['databases'],
          maxPapers: 5,
        },
      });
      expect(await notificationsOf(reviewer.id)).toContainEqual({
        kind: 'member_invited',
        title: 'You are invited as reviewer',
      });

      // Inviting again changes nothing.
      const again = await as(chair.token)
        .post(`/conferences/${id}/members`, { email: reviewer.email })
        .expect(200);
      expect(again.body.created).toBe(false);

      const mine = await as(reviewer.token).get('/invitations').expect(200);
      expect(mine.body).toHaveLength(1);
      expect(mine.body[0]).toMatchObject({
        status: 'invited',
        conference: { id, acronym: 'ISBM 2027' },
      });

      const accepted = await as(reviewer.token)
        .post(`/invitations/${mine.body[0].id}/accept`)
        .expect(200);
      expect(accepted.body.status).toBe('active');
      await as(reviewer.token)
        .post(`/invitations/${mine.body[0].id}/accept`)
        .expect(422);
      expect(await notificationsOf(chair.id)).toContainEqual({
        kind: 'invitation_answer',
        title: 'Rae Viewer accepted the reviewer invitation',
      });

      const seen = await as(reviewer.token)
        .get(`/conferences/${id}`)
        .expect(200);
      expect(seen.body.myRoles).toEqual(['reviewer']);
    });

    it('links an invitation to the account made later with that address', async () => {
      const chair = await person();
      const id = await liveConference(chair);
      const invited = await as(chair.token)
        .post(`/conferences/${id}/members`, {
          email: 'Later@Example.test',
          displayName: 'Lee Later',
        })
        .expect(201);
      expect(invited.body.member).toMatchObject({
        userId: null,
        name: 'Lee Later',
        email: 'later@example.test',
      });

      // Registering and confirming the address claims the invitation.
      await http()
        .post(api('/auth/register'))
        .send({
          email: 'later@example.test',
          password: 'correct horse battery',
          firstName: 'Lee',
          lastName: 'Later',
          termsVersion: '2026-10-01',
        })
        .expect(202);
      const link = t
        .outbox()
        .at(-1)!
        .text.match(/token=([\w-]+)/)![1];
      const verified = await http()
        .post(api('/auth/verify-email'))
        .send({ token: link })
        .expect(200);
      const mine = await as(verified.body.accessToken)
        .get('/invitations')
        .expect(200);
      expect(mine.body.map((i: { id: string }) => i.id)).toEqual([
        invited.body.member.id,
      ]);
    });

    it('declining hands back papers already given', async () => {
      const chair = await person();
      const id = await liveConference(chair);
      const reviewer = await person();
      const invited = await as(chair.token)
        .post(`/conferences/${id}/members`, { email: reviewer.email })
        .expect(201);
      const { rows } = await t.db.query<{ id: string }>(
        `insert into submissions (conference_id, submitter_id, title, paper_no) values ($1, $2, 'A paper', 1) returning id`,
        [id, chair.id],
      );
      await t.db.query(
        `insert into review_assignments (submission_id, reviewer_id) values ($1, $2)`,
        [rows[0].id, reviewer.id],
      );

      await as(reviewer.token)
        .post(`/invitations/${invited.body.member.id}/decline`, {
          reason: 'Too busy',
        })
        .expect(200);
      const { rows: assignments } = await t.db.query(
        'select status, decline_reason from review_assignments',
      );
      expect(assignments).toEqual([
        { status: 'declined', decline_reason: 'Too busy' },
      ]);

      // A fresh invitation can be sent after a decline.
      const reinvited = await as(chair.token)
        .post(`/conferences/${id}/members`, { email: reviewer.email })
        .expect(201);
      expect(reinvited.body.member).toMatchObject({
        id: invited.body.member.id,
        status: 'invited',
        declineReason: null,
      });
    });

    it('only chairs manage the team, and the last chair stays', async () => {
      const chair = await person();
      const id = await liveConference(chair);
      const reviewer = await person();
      await t.db.query(
        `insert into conference_members (conference_id, user_id, role, status) values ($1, $2, 'reviewer', 'active')`,
        [id, reviewer.id],
      );
      await as(reviewer.token).get(`/conferences/${id}/members`).expect(403);
      await as(reviewer.token)
        .post(`/conferences/${id}/members`, { email: 'x@example.test' })
        .expect(403);

      const team = await as(chair.token)
        .get(`/conferences/${id}/members`)
        .expect(200);
      const chairRow = team.body.find(
        (m: { role: string }) => m.role === 'chair',
      );
      const reviewerRow = team.body.find(
        (m: { role: string }) => m.role === 'reviewer',
      );
      const res = await as(chair.token)
        .delete(`/conferences/${id}/members/${chairRow.id}`)
        .expect(422);
      expect(res.body.code).toBe('BUSINESS_RULE');

      await as(chair.token)
        .patch(`/conferences/${id}/members/${reviewerRow.id}`, {
          expertise: ['ml'],
        })
        .expect(200);
      await as(chair.token)
        .delete(`/conferences/${id}/members/${reviewerRow.id}`)
        .expect(204);
      const after = await as(chair.token)
        .get(`/conferences/${id}/members?role=reviewer`)
        .expect(200);
      expect(after.body).toEqual([]);
      // Removed: the conference is no longer theirs to see.
      await as(reviewer.token).get(`/conferences/${id}`).expect(404);
    });
  });
  describe('emails', () => {
    const emailsTo = async (email: string) =>
      (
        await t.db.query<{ template_key: string; status: string }>(
          'select template_key, status from email_log where lower(to_email) = lower($1) order by created_at, template_key',
          [email],
        )
      ).rows.map((r) => r.template_key);

    it('emails the super admins a request and the chair the decision', async () => {
      const chair = await person({ firstName: 'Chair', lastName: 'Person' });
      const admin = await superAdmin();
      const created = await as(chair.token)
        .post('/conferences', request_)
        .expect(201);
      expect(await emailsTo(admin.email)).toEqual(['conferenceRequestAdmin']);
      await as(admin.token)
        .post(`/admin/conferences/${created.body.id}/decision`, {
          approve: true,
        })
        .expect(204);
      expect(await emailsTo(chair.email)).toEqual(['conferenceApproved']);
      await expect(t.sendQueuedEmails()).resolves.toMatchObject({ failed: 0 });
      expect(t.outbox().map((m) => m.subject)).toEqual(
        expect.arrayContaining([
          'New conference request: ISBM 2027',
          'ISBM 2027 is approved',
        ]),
      );
    });

    it('emails an invited reviewer (welcoming a newcomer) and the chairs when they join', async () => {
      const chair = await person({ firstName: 'Chair', lastName: 'Person' });
      const id = await liveConference(chair);
      await as(chair.token)
        .post(`/conferences/${id}/members`, { email: 'new@reviewer.example' })
        .expect(201);
      expect(await emailsTo('new@reviewer.example')).toEqual([
        'reviewerInvited',
        'welcome',
      ]);

      const reviewer = await person({ firstName: 'Rae', lastName: 'Viewer' });
      await as(chair.token)
        .post(`/conferences/${id}/members`, { email: reviewer.email })
        .expect(201);
      expect(await emailsTo(reviewer.email)).toEqual(['reviewerInvited']);
      const [invitation] = (
        await as(reviewer.token).get('/invitations').expect(200)
      ).body;
      await as(reviewer.token)
        .post(`/invitations/${invitation.id}/accept`)
        .expect(200);
      expect(await emailsTo(chair.email)).toContain('teamMemberJoined');
      await t.sendQueuedEmails();
      const toReviewer = t.outbox().find((m) => m.to === reviewer.email);
      expect(toReviewer?.subject).toMatch(/ISBM 2027/);
    });
  });
});
