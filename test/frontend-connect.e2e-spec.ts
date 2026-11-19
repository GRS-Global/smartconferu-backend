import request from 'supertest';
import {
  createTestApp,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

/** The endpoints added for the frontend: slug-or-UUID, paper labels, dashboard, chair overview, uploads. */
describe('Frontend connection helpers', () => {
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

  async function openConference(chair: { token: string }) {
    const created = await as(chair.token)
      .post('/conferences', {
        acronym: 'ICX 2027',
        title: 'International Conference X 2027',
        startDate: '2027-06-01',
        endDate: '2027-06-03',
      })
      .expect(201);
    const id = created.body.id as string;
    const slug = created.body.slug as string;
    const admin = await superAdmin();
    await as(admin.token)
      .post(`/admin/conferences/${id}/decision`, { approve: true })
      .expect(204);
    await as(chair.token).post(`/conferences/${id}/cfp/publish`).expect(200);
    await as(admin.token)
      .post(`/admin/conferences/${id}/cfp/decision`, { approve: true })
      .expect(204);
    return { id, slug };
  }

  async function setup() {
    const chair = await person({ firstName: 'Carla', lastName: 'Chair' });
    const author = await person({ firstName: 'Ada', lastName: 'Author' });
    const conf = await openConference(chair);
    const res = await as(author.token)
      .post(`/conferences/${conf.id}/submissions`, {
        title: 'Graph networks for protein folding',
        abstract: 'We show that graph networks fold proteins.',
        keywords: ['GNN'],
        track: 'AI Track',
        authors: [
          { name: 'Ada Author', email: author.email, corresponding: true },
        ],
      })
      .expect(201);
    return { chair, author, conf, paper: res.body };
  }

  describe('conference slug in place of the UUID', () => {
    it('accepts the slug or the UUID, and answers 404 for an unknown one', async () => {
      const { chair, conf } = await setup();
      const byId = await as(chair.token)
        .get(`/conferences/${conf.id}`)
        .expect(200);
      const bySlug = await as(chair.token)
        .get(`/conferences/${conf.slug}`)
        .expect(200);
      expect(bySlug.body.id).toBe(byId.body.id);
      await as(chair.token).get('/conferences/no-such-conference').expect(404);
      await as(chair.token).get(`/conferences/${conf.slug}/cfp`).expect(200);
      await as(chair.token)
        .get(`/conferences/${conf.slug}/submissions`)
        .expect(200);
    });
  });

  describe('GET /public/conferences/:slug/submission-form', () => {
    it("gives authors the chair's tracks, types, extra questions and guidelines without a sign-in", async () => {
      const chair = await person({ firstName: 'Carla', lastName: 'Chair' });
      const conf = await openConference(chair);
      // Not saved yet: empty lists, the page uses its defaults.
      const bare = await http()
        .get(api(`/public/conferences/${conf.slug}/submission-form`))
        .expect(200);
      expect(bare.body).toEqual({
        tracks: [],
        presentationTypes: [],
        extras: [],
        guidelines: '',
      });
      await http()
        .patch(api(`/conferences/${conf.id}/settings`))
        .set('Authorization', `Bearer ${chair.token}`)
        .send({
          settings: {
            tracks: [
              { id: 't1', name: 'AI Track', description: '' },
              { id: 't2', name: '  ', description: '' },
            ],
            presentationTypes: ['Paper Presentation', 'Poster'],
            submissionForm: {
              extras: [
                {
                  id: 'q1',
                  type: 'short_text',
                  label: 'Funding',
                  required: true,
                },
              ],
            },
            submissionPolicy: { guidelines: 'Max 10 pages.' },
          },
        })
        .expect(200);
      const form = await http()
        .get(api(`/public/conferences/${conf.slug}/submission-form`))
        .expect(200);
      expect(form.body.tracks).toEqual(['AI Track']);
      expect(form.body.presentationTypes).toEqual([
        'Paper Presentation',
        'Poster',
      ]);
      expect(form.body.extras).toHaveLength(1);
      expect(form.body.guidelines).toBe('Max 10 pages.');
      // The conference record itself stays closed to someone with no part in it, so this public route is how an author reads the form.
      const stranger = await person();
      await as(stranger.token).get(`/conferences/${conf.slug}`).expect(404);
      await http()
        .get(api('/public/conferences/no-such-conference/submission-form'))
        .expect(404);
    });

    it('is not offered for a conference that is not active yet', async () => {
      const chair = await person();
      const created = await as(chair.token)
        .post('/conferences', {
          acronym: 'WAIT 2027',
          title: 'Waiting Conference',
          startDate: '2027-06-01',
          endDate: '2027-06-03',
        })
        .expect(201);
      await http()
        .get(api(`/public/conferences/${created.body.slug}/submission-form`))
        .expect(404);
    });
  });

  describe('paper labels', () => {
    it('finds a paper by its label, and filters a conference list by paperNo', async () => {
      const { author, chair, conf, paper } = await setup();
      const label = paper.paperId as string; // e.g. ICX-1
      const found = await as(author.token)
        .get(`/submissions/by-label/${label}`)
        .expect(200);
      expect(found.body.id).toBe(paper.id);
      await as(chair.token)
        .get(`/submissions/by-label/${label.toLowerCase()}`)
        .expect(200);
      await as(author.token).get('/submissions/by-label/ICX-99').expect(404);
      await as(author.token).get('/submissions/by-label/nonsense').expect(404);

      // someone with no access gets the same 404 as a missing paper
      const stranger = await person();
      await as(stranger.token)
        .get(`/submissions/by-label/${label}`)
        .expect(404);

      const filtered = await as(chair.token)
        .get(`/conferences/${conf.slug}/submissions?paperNo=${paper.paperNo}`)
        .expect(200);
      expect(filtered.body.map((p: { id: string }) => p.id)).toEqual([
        paper.id,
      ]);
      const none = await as(chair.token)
        .get(`/conferences/${conf.slug}/submissions?paperNo=77`)
        .expect(200);
      expect(none.body).toEqual([]);
    });
  });

  describe('GET /me/dashboard', () => {
    it('gives each person the roles and papers that are theirs', async () => {
      const { author, chair, conf, paper } = await setup();

      const chairView = await as(chair.token).get('/me/dashboard').expect(200);
      expect(chairView.body.conferences).toHaveLength(1);
      expect(chairView.body.conferences[0]).toMatchObject({
        conferenceId: conf.id,
        slug: conf.slug,
        status: 'active',
      });
      expect(chairView.body.conferences[0].roles).toContain('chair');
      expect(chairView.body.chairPapers).toHaveLength(1);
      expect(chairView.body.authorPapers).toEqual([]);

      const authorView = await as(author.token)
        .get('/me/dashboard')
        .expect(200);
      expect(authorView.body.conferences[0].roles).toEqual(['author']);
      expect(authorView.body.authorPapers).toEqual([
        expect.objectContaining({
          submissionId: paper.id,
          paperNo: paper.paperNo,
          status: 'submitted',
          notifiedOutcome: null,
        }),
      ]);
      // an author never gets the chair's papers
      expect(authorView.body.chairPapers).toEqual([]);

      const nobody = await person();
      const empty = await as(nobody.token).get('/me/dashboard').expect(200);
      expect(empty.body).toEqual({
        conferences: [],
        authorPapers: [],
        chairPapers: [],
        reviewerAssignments: [],
        invitations: [],
      });
    });
  });

  describe('chair overview', () => {
    it('is for chairs only and shows papers with review progress', async () => {
      const { author, chair, conf, paper } = await setup();
      const res = await as(chair.token)
        .get(`/conferences/${conf.slug}/chair-overview`)
        .expect(200);
      expect(res.body).toMatchObject({
        conferenceId: conf.id,
        cfpStatus: 'published',
      });
      expect(res.body.papers).toEqual([
        expect.objectContaining({
          id: paper.id,
          reviewersAssigned: 0,
          reviewsReceived: 0,
          averageScore: null,
        }),
      ]);
      expect(Array.isArray(res.body.decisionTypes)).toBe(true);
      expect(res.body.screening).toHaveProperty('criteria');

      await as(author.token)
        .get(`/conferences/${conf.id}/chair-overview`)
        .expect(403);
    });
  });

  describe('accounts without a password (created through Google, ...)', () => {
    it('says so on /me and lets them set a password without a current one, once', async () => {
      const user = await person();
      const me = await as(user.token).get('/me').expect(200);
      expect(me.body.hasPassword).toBe(true);

      await t.db.query('update users set password_hash = null where id = $1', [
        user.id,
      ]);
      const noPw = await as(user.token).get('/me').expect(200);
      expect(noPw.body.hasPassword).toBe(false);

      await as(user.token)
        .post('/auth/password/change', { newPassword: 'a-new-Password-9' })
        .expect(204);
      const withPw = await as(user.token).get('/me').expect(200);
      expect(withPw.body.hasPassword).toBe(true);

      // from now on the current password is required
      await as(user.token)
        .post('/auth/password/change', { newPassword: 'another-Password-8' })
        .expect(400);
    });
  });

  describe('POST /auth/account/delete', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32),
    ]);
    const del = (token: string, confirm: string) =>
      http()
        .post(api('/auth/account/delete'))
        .set('Authorization', `Bearer ${token}`)
        .send({ confirm });

    it('needs DELETE typed, then removes the account, its rows and its files', async () => {
      const user = await person({ firstName: 'Gone', lastName: 'Soon' });
      const up = await http()
        .post(api('/files?purpose=profile_photo'))
        .set('Authorization', `Bearer ${user.token}`)
        .attach('file', png, 'me.png')
        .expect(201);
      const photoUrl = api(
        `/files/public?path=${encodeURIComponent(up.body.path)}`,
      );
      await http().get(photoUrl).expect(200);

      await del(user.token, 'nope').expect(400);
      await as(user.token).get('/me').expect(200); // still there

      await del(user.token, ' delete ').expect(204);

      for (const [table, column] of [
        ['users', 'id'],
        ['profiles', 'id'],
        ['profile_details', 'user_id'],
        ['sessions', 'user_id'],
      ]) {
        const left = await t.db.query(
          `select 1 from ${table} where ${column} = $1`,
          [user.id],
        );
        expect(left.rows, table).toHaveLength(0);
      }
      const audit = await t.db.query<{ actor_id: string | null }>(
        "select actor_id from audit_log where action = 'account.deleted' and entity_id = $1",
        [user.id],
      );
      expect(audit.rows).toEqual([{ actor_id: null }]);

      await http().get(photoUrl).expect(404); // its files went too
      await http()
        .post(api('/auth/sign-in'))
        .send({ email: user.email, password: user.password })
        .expect(401);
    });

    it('refuses while the account owns records that belong to conferences', async () => {
      const { author, chair } = await setup();

      const chairRes = await del(chair.token, 'DELETE').expect(409);
      expect(chairRes.body.code).toBe('CONFLICT');
      expect(chairRes.body.details.blockers.join(' ')).toMatch(
        /conference you created/,
      );

      const authorRes = await del(author.token, 'DELETE').expect(409);
      expect(authorRes.body.details.blockers.join(' ')).toMatch(
        /paper you submitted/,
      );

      // nothing was changed
      await as(chair.token).get('/me').expect(200);
      await as(author.token).get('/me').expect(200);
    });
  });

  describe('review board', () => {
    it('lists every submitted paper with its reviewers, for chairs only', async () => {
      const { author, chair, conf, paper } = await setup();
      const empty = await as(chair.token)
        .get(`/conferences/${conf.slug}/review-board`)
        .expect(200);
      expect(empty.body.papers).toEqual([
        { submissionId: paper.id, assignments: [], pending: [] },
      ]);

      const reviewer = await person({
        firstName: 'Rita',
        lastName: 'Reviewer',
      });
      await t.db.query(
        "insert into conference_members (conference_id, user_id, role, status) values ($1, $2, 'reviewer', 'active')",
        [conf.id, reviewer.id],
      );
      await t.db.query(
        'insert into review_assignments (submission_id, reviewer_id, assigned_by) values ($1, $2, $3)',
        [paper.id, reviewer.id, chair.id],
      );
      const res = await as(chair.token)
        .get(`/conferences/${conf.slug}/review-board`)
        .expect(200);
      expect(res.body.papers).toHaveLength(1);
      expect(res.body.papers[0].assignments).toHaveLength(1);
      expect(res.body.papers[0].assignments[0].reviewer.name).toBe(
        'Rita Reviewer',
      );
      expect(res.body.papers[0].assignments[0].status).toBe('assigned');

      await as(author.token)
        .get(`/conferences/${conf.id}/review-board`)
        .expect(403);
      await as(reviewer.token)
        .get(`/conferences/${conf.id}/review-board`)
        .expect(403);
    });
  });

  describe('chair actions on papers', () => {
    const PDF = Buffer.from('%PDF-1.7\n%%EOF\n');
    const send = (
      method: 'patch' | 'put' | 'delete',
      token: string,
      path: string,
      body?: object,
    ) =>
      http()
        [method](api(path))
        .set('Authorization', `Bearer ${token}`)
        .send(body ?? {});
    const upload = (token: string, paperId: string) =>
      http()
        .post(api(`/submissions/${paperId}/files`))
        .set('Authorization', `Bearer ${token}`)
        .attach('file', PDF, 'paper.pdf');

    it("moves one reviewer's deadline, and tells them", async () => {
      const { chair, author, conf, paper } = await setup();
      const reviewer = await person({ firstName: 'Rita', lastName: 'Rev' });
      const member = await as(chair.token)
        .post(`/conferences/${conf.id}/members`, {
          email: reviewer.email,
          role: 'reviewer',
        })
        .expect(201);
      await as(reviewer.token)
        .post(`/invitations/${member.body.member.id}/accept`)
        .expect(200);
      const given = await as(chair.token)
        .post(`/submissions/${paper.id}/assignments`, {
          memberIds: [member.body.member.id],
          dueDate: '2099-04-30',
        })
        .expect(200);
      const assignmentId = given.body.assignments[0].id as string;

      await send(
        'patch',
        chair.token,
        `/assignments/${assignmentId}/due-date`,
        {
          date: '2001-01-01',
        },
      ).expect(422);
      await send(
        'patch',
        reviewer.token,
        `/assignments/${assignmentId}/due-date`,
        {
          date: '2099-06-01',
        },
      ).expect(404);
      await send(
        'patch',
        author.token,
        `/assignments/${assignmentId}/due-date`,
        {
          date: '2099-06-01',
        },
      ).expect(404);
      const moved = await send(
        'patch',
        chair.token,
        `/assignments/${assignmentId}/due-date`,
        { date: '2099-06-01' },
      ).expect(200);
      expect(moved.body.dueAt).toMatch(/^2099-06-01/);
      const mine = await as(reviewer.token)
        .get('/me/review-assignments')
        .expect(200);
      expect(mine.body[0].dueAt).toMatch(/^2099-06-01/);
      const bell = await t.db.query(
        "select title from notifications where kind = 'due_date_changed' and user_id = $1",
        [reviewer.id],
      );
      expect(bell.rows).toHaveLength(1);
      await t.sendQueuedEmails();
      expect(
        t
          .outbox()
          .some(
            (m) =>
              m.to === reviewer.email &&
              /New review deadline for/.test(m.subject),
          ),
      ).toBe(true);
    });

    it('lets a chair email some authors of a paper, with their names filled in', async () => {
      const { chair, author, paper } = await setup();
      const send = (token: string, body: object) =>
        as(token).post(`/submissions/${paper.id}/email`, body);
      const message = {
        to: [author.email],
        subject: '{{submission_id}}: a question',
        body: '<p>Hi {{first_name}}, about {{paper_title}}.</p>',
      };
      await send(author.token, message).expect(403);
      await send(chair.token, { ...message, body: '<p> </p>' }).expect(400);
      await send(chair.token, { ...message, to: ['stranger@example.org'] }).expect(
        422,
      );
      const done = await send(chair.token, message).expect(200);
      expect(done.body.queued).toBe(1);
      await t.sendQueuedEmails();
      const mail = t.outbox().find((m) => m.to === author.email && /a question/.test(m.subject));
      expect(mail).toBeDefined();
      expect(mail!.subject).toMatch(/^[A-Z0-9]+-\d+: a question$/);
      expect(mail!.html).toMatch(/Hi Ada, about Graph networks/);
      // it is listed in Email Logs
      const log = await as(chair.token)
        .get(`/conferences/${paper.conferenceId}/email-log`)
        .expect(200);
      expect(
        log.body.data.some(
          (l: { event: string; submissionId: string }) =>
            l.event === 'paper_message' && l.submissionId === paper.id,
        ),
      ).toBe(true);
    });

    it('asks the authors to fix something; a new version answers it', async () => {
      const { chair, author, paper } = await setup();
      const ask = (token: string, body: object) =>
        as(token).post(`/submissions/${paper.id}/fix-request`, body);
      await ask(chair.token, {
        issue: 'Fonts are too small.',
        fixBy: '2001-01-01',
      }).expect(422);
      await ask(author.token, {
        issue: 'Fonts are too small.',
        fixBy: '2099-03-01',
      }).expect(403);
      await ask(chair.token, { issue: '  ', fixBy: '2099-03-01' }).expect(400);
      const done = await ask(chair.token, {
        issue: 'Fonts are too small.',
        fixBy: '2099-03-01',
      }).expect(200);
      expect(done.body.fixRequest).toMatchObject({
        issue: 'Fonts are too small.',
        fixBy: '2099-03-01',
      });
      // the authors see it and are told; reviewers never see it
      const seen = await as(author.token)
        .get(`/submissions/${paper.id}`)
        .expect(200);
      expect(seen.body.fixRequest.issue).toBe('Fonts are too small.');
      const bell = await t.db.query(
        "select title from notifications where kind = 'fix_requested' and user_id = $1",
        [author.id],
      );
      expect(bell.rows).toHaveLength(1);
      await t.sendQueuedEmails();
      expect(
        t
          .outbox()
          .some(
            (m) => m.to === author.email && /Please fix .* by/.test(m.subject),
          ),
      ).toBe(true);
      // the corrected file answers it
      await upload(author.token, paper.id).expect(201);
      const after = await as(author.token)
        .get(`/submissions/${paper.id}`)
        .expect(200);
      expect(after.body.fixRequest).toBeNull();
    });

    it('moves papers to another track and deletes them, for chairs of that conference only', async () => {
      const { chair, author, conf, paper } = await setup();
      const stranger = await person();
      const otherConf = await openConference(stranger);
      const track = (token: string, body: object) =>
        send('patch', token, `/conferences/${conf.id}/submissions/track`, body);
      await track(author.token, {
        ids: [paper.id],
        track: 'Systems Track',
      }).expect(403);
      await track(stranger.token, {
        ids: [paper.id],
        track: 'Systems Track',
      }).expect(404);
      await track(chair.token, { ids: [], track: 'Systems Track' }).expect(400);
      const changed = await track(chair.token, {
        ids: [paper.id, '00000000-0000-4000-8000-000000000000'],
        track: 'Systems Track',
      }).expect(200);
      expect(changed.body.count).toBe(1); // the unknown id is ignored
      const view = await as(chair.token)
        .get(`/submissions/${paper.id}`)
        .expect(200);
      expect(view.body.track).toBe('Systems Track');
      // another conference's chair cannot touch it through their own conference either
      const none = await send(
        'patch',
        stranger.token,
        `/conferences/${otherConf.id}/submissions/track`,
        {
          ids: [paper.id],
          track: 'X',
        },
      ).expect(200);
      expect(none.body.count).toBe(0);

      const del = (token: string, id = conf.id) =>
        as(token).post(`/conferences/${id}/submissions/delete`, {
          ids: [paper.id],
        });
      await del(author.token).expect(403);
      expect(
        (await del(stranger.token, otherConf.id).expect(200)).body.count,
      ).toBe(0);
      expect((await del(chair.token).expect(200)).body.count).toBe(1);
      await as(chair.token).get(`/submissions/${paper.id}`).expect(404);
      await as(author.token).get(`/submissions/${paper.id}`).expect(404);
    });

    it("keeps a screening report uploaded for the conference on the paper's screening record", async () => {
      const { chair, conf, author, paper } = await setup();
      await upload(author.token, paper.id).expect(201);
      const report = await http()
        .post(api(`/files?purpose=screening_report&conferenceId=${conf.id}`))
        .set('Authorization', `Bearer ${chair.token}`)
        .attach('file', PDF, 'report.pdf')
        .expect(201);
      const save = (paths: Record<string, string>) =>
        send('put', chair.token, `/submissions/${paper.id}/screening/1`, {
          record: { paths },
        });
      await save({ 'report.pdf': report.body.path }).expect(200);
      await save({ 'report.pdf': `conferences/${conf.id}/../x.pdf` }).expect(
        400,
      );
      await save({ 'report.pdf': 'someone-elses/file.pdf' }).expect(400);
      const view = await as(chair.token)
        .get(`/submissions/${paper.id}`)
        .expect(200);
      expect(view.body.screening['1'].paths['report.pdf']).toBe(
        report.body.path,
      );
    });
  });

  describe('uploads', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32),
    ]);

    it('stores a profile photo that can be read back', async () => {
      const user = await person();
      const up = await http()
        .post(api('/files?purpose=profile_photo'))
        .set('Authorization', `Bearer ${user.token}`)
        .attach('file', png, 'me.png')
        .expect(201);
      expect(up.body.path).toMatch(new RegExp(`^${user.id}/photo-.+\\.png$`));
      expect(up.body.contentType).toBe('image/png');
      const audit = await t.db.query<{
        entity_type: string;
        data: { purpose: string; path: string };
      }>(
        "select entity_type, data from audit_log where action = 'file.uploaded' and actor_id = $1",
        [user.id],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].entity_type).toBe('user');
      expect(audit.rows[0].data).toMatchObject({
        purpose: 'profile_photo',
        path: up.body.path,
      });

      // the profile accepts it (it must live in the user's own folder)
      await http()
        .patch(api('/me'))
        .set('Authorization', `Bearer ${user.token}`)
        .send({ photoPath: up.body.path })
        .expect(200);

      const read = await as(user.token)
        .get(`/files?path=${encodeURIComponent(up.body.path)}`)
        .expect(200);
      expect(read.headers['content-type']).toContain('image/png');
      await http()
        .get(api(`/files/public?path=${encodeURIComponent(up.body.path)}`))
        .expect(200);
      await http().get(api('/files/public?path=../../etc/passwd')).expect(404);
    });

    it('refuses a file that is not what it says, and one that is too big', async () => {
      const user = await person();
      await http()
        .post(api('/files?purpose=profile_photo'))
        .set('Authorization', `Bearer ${user.token}`)
        .attach('file', Buffer.from('not an image'), 'me.png')
        .expect(400);
      await http()
        .post(api('/files?purpose=profile_photo'))
        .set('Authorization', `Bearer ${user.token}`)
        .attach(
          'file',
          Buffer.concat([png, Buffer.alloc(6 * 1024 * 1024)]),
          'big.png',
        )
        .expect(400);
      await http()
        .post(api('/files?purpose=bogus'))
        .set('Authorization', `Bearer ${user.token}`)
        .attach('file', png, 'me.png')
        .expect(400);
    });

    it('lets a chair upload the conference logo (public to read) and nobody else', async () => {
      const { author, chair, conf } = await setup();
      const up = await http()
        .post(api(`/files?purpose=conference_logo&conferenceId=${conf.slug}`))
        .set('Authorization', `Bearer ${chair.token}`)
        .attach('file', png, 'logo.png')
        .expect(201);
      const got = await as(chair.token)
        .get(`/conferences/${conf.id}`)
        .expect(200);
      expect(got.body.logoPath).toBe(up.body.path);
      await http()
        .get(api(`/files/public?path=${encodeURIComponent(up.body.path)}`))
        .expect(200);

      await http()
        .post(api(`/files?purpose=conference_logo&conferenceId=${conf.id}`))
        .set('Authorization', `Bearer ${author.token}`)
        .attach('file', png, 'logo.png')
        .expect(403);
      await http()
        .post(api('/files?purpose=conference_logo'))
        .set('Authorization', `Bearer ${chair.token}`)
        .attach('file', png, 'logo.png')
        .expect(400);
    });
  });
});
