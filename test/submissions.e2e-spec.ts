import request from 'supertest';
import {
  createTestApp,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

describe('Submissions, screening and the email queue', () => {
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
    put: (path: string, body: object) =>
      http().put(api(path)).set('Authorization', `Bearer ${token}`).send(body),
  });

  /** An approved conference with its CFP published (unless told otherwise). */
  async function openConference(
    chair: { token: string },
    { publish = true, deadline }: { publish?: boolean; deadline?: string } = {},
  ) {
    const created = await as(chair.token)
      .post('/conferences', {
        acronym: 'ICX 2027',
        title: 'International Conference X 2027',
        startDate: '2027-06-01',
        endDate: '2027-06-03',
      })
      .expect(201);
    const id = created.body.id as string;
    const admin = await superAdmin();
    await as(admin.token)
      .post(`/admin/conferences/${id}/decision`, { approve: true })
      .expect(204);
    if (deadline) {
      await t.db.query(
        'update conferences set submission_deadline = $2 where id = $1',
        [id, deadline],
      );
    }
    if (publish) {
      await as(chair.token).post(`/conferences/${id}/cfp/publish`).expect(200);
      await as(admin.token)
        .post(`/admin/conferences/${id}/cfp/decision`, { approve: true })
        .expect(204);
    }
    // The conference's own emails (approval) are not what these tests look at.
    await t.sendQueuedEmails();
    t.outbox().length = 0;
    return id;
  }

  /** Every author must give affiliation and country: fill in a default where a test leaves them out. */
  const withPlace = <T extends object>(authors: T[]) =>
    authors.map((a) => ({
      affiliation: 'Test University',
      city: 'Pune',
      country: 'India',
      ...a,
    }));
  const paper = (
    authors: {
      name: string;
      email: string;
      corresponding?: boolean;
      affiliation?: string;
      department?: string;
      city?: string;
      country?: string;
    }[],
    extra: object = {},
  ) => ({
    title: 'Graph networks for protein folding',
    abstract: 'We show that graph networks fold proteins.',
    keywords: ['GNN', 'proteins'],
    track: 'AI Track',
    authors: withPlace(authors),
    ...extra,
  });

  const sent = () => t.outbox().map((m) => ({ to: m.to, subject: m.subject }));
  const templatesTo = async (email: string) =>
    (
      await t.db.query<{ template_key: string; status: string }>(
        // Paper emails only (the conference's approval email is not what these tests look at).
        `select template_key, status from email_log
          where lower(to_email) = lower($1) and event not like 'conference%'
          order by created_at, template_key`,
        [email],
      )
    ).rows;
  const bell = async (userId: string) =>
    (
      await t.db.query<{ kind: string }>(
        'select kind from notifications where user_id = $1',
        [userId],
      )
    ).rows.map((r) => r.kind);

  /** An author's paper with a co-author who has an account and one who has none. */
  async function submitted() {
    const chair = await person({ firstName: 'Carla', lastName: 'Chair' });
    const author = await person({ firstName: 'Ada', lastName: 'Author' });
    const coAuthor = await person({ firstName: 'Cole', lastName: 'Coauthor' });
    const conferenceId = await openConference(chair);
    const res = await as(author.token)
      .post(
        `/conferences/${conferenceId}/submissions`,
        paper([
          {
            name: 'Ada Author',
            email: author.email,
            corresponding: true,
            affiliation: 'IIT Bombay',
            department: 'Department of Computer Science',
            city: 'Mumbai',
            country: 'India',
          },
          { name: 'Cole Coauthor', email: coAuthor.email.toUpperCase() },
          { name: 'Nina New', email: 'nina@new.example' },
        ]),
      )
      .expect(201);
    return { chair, author, coAuthor, conferenceId, submission: res.body };
  }

  describe('submitting', () => {
    it('creates the paper, links co-authors and queues the emails with it', async () => {
      const { chair, author, coAuthor, submission } = await submitted();
      expect(submission).toMatchObject({
        paperId: 'ICX-1',
        paperNo: 1,
        view: 'author',
        status: 'submitted',
        outcome: 'upload_pending',
        track: 'AI Track',
        mySubmission: true,
        myCorresponding: true,
        can: { editDetails: true, editAuthors: true, withdraw: true },
      });
      expect(submission.authors).toEqual([
        expect.objectContaining({
          email: author.email,
          hasAccount: true,
          affiliation: 'IIT Bombay',
          department: 'Department of Computer Science',
          city: 'Mumbai',
          country: 'India',
        }),
        expect.objectContaining({ hasAccount: true, corresponding: false }),
        expect.objectContaining({
          email: 'nina@new.example',
          hasAccount: false,
        }),
      ]);

      // Queued with the paper, nothing sent yet.
      expect(t.outbox()).toHaveLength(0);
      expect(await templatesTo(author.email)).toEqual([
        { template_key: 'submissionReceived', status: 'queued' },
      ]);

      await expect(t.sendQueuedEmails()).resolves.toEqual({
        sent: 5,
        failed: 0,
      });
      expect(sent()).toEqual(
        expect.arrayContaining([
          {
            to: author.email,
            subject:
              'Submission received: Graph networks for protein folding (ICX-1)',
          },
          expect.objectContaining({ to: chair.email }),
          expect.objectContaining({ to: coAuthor.email.toUpperCase() }),
          expect.objectContaining({ to: 'nina@new.example' }),
        ]),
      );
      expect(await templatesTo('nina@new.example')).toEqual([
        { template_key: 'coAuthorAdded', status: 'sent' },
        { template_key: 'welcome', status: 'sent' },
      ]);
      expect(await templatesTo(chair.email)).toEqual([
        { template_key: 'newSubmissionAlert', status: 'sent' },
      ]);
      // The email is the conference's template in the platform frame.
      const receipt = t.outbox().find((m) => m.to === author.email)!;
      expect(receipt.html).toContain('ICX 2027');
      expect(receipt.text).toContain('Submission ID: ICX-1');

      expect(await bell(chair.id)).toContain('new_submission');
      expect(await bell(coAuthor.id)).toEqual(['coauthor_added']);
    });

    it('needs affiliation and country (not the city) from every author', async () => {
      const chair = await person({ firstName: 'Carla', lastName: 'Chair' });
      const author = await person({ firstName: 'Ada', lastName: 'Author' });
      const conferenceId = await openConference(chair);
      const place = {
        affiliation: 'IIT Bombay',
        city: 'Mumbai',
        country: 'India',
      };
      const me = {
        name: 'Ada Author',
        email: author.email,
        corresponding: true,
      };
      let n = 0;
      const send = (authors: object[]) =>
        as(author.token).post(`/conferences/${conferenceId}/submissions`, {
          ...paper([]),
          title: `Place rule paper ${++n}`,
          authors,
        });

      const noCountry = await send([
        { ...me, ...place },
        {
          name: 'Ben Two',
          email: 'ben@two.example',
          affiliation: 'MIT',
        },
      ]).expect(400);
      expect(noCountry.body.message).toMatch(/Author 2 needs country/);

      // The city is optional, even for the first two.
      await send([
        { ...me, affiliation: 'IIT Bombay', country: 'India' },
        {
          name: 'Ben Two',
          email: 'ben@two.example',
          affiliation: 'MIT',
          country: 'USA',
        },
      ]).expect(201);

      // The third author too: nobody may leave the affiliation out.
      const third = await send([
        { ...me, ...place },
        { name: 'Ben Two', email: 'ben@two.example', ...place },
        { name: 'Cy Three', email: 'cy@three.example' },
      ]).expect(400);
      expect(third.body.message).toMatch(/Author 3 needs affiliation, country/);
      await send([
        { ...me, ...place },
        { name: 'Ben Two', email: 'ben@two.example', ...place },
        { name: 'Cy Three', email: 'cy@three.example', ...place },
      ]).expect(201);
    });

    it('keeps one entry per author with all of their affiliations (primary first)', async () => {
      const chair = await person({ firstName: 'Carla', lastName: 'Chair' });
      const author = await person({ firstName: 'Ada', lastName: 'Author' });
      const conferenceId = await openConference(chair);
      const created = await as(author.token)
        .post(`/conferences/${conferenceId}/submissions`, {
          ...paper([]),
          title: 'Two affiliations',
          authors: [
            {
              name: 'Ada Author',
              email: author.email,
              corresponding: true,
              affiliation: 'IIT Bombay',
              country: 'India',
              otherAffiliations: [
                { affiliation: 'MIT', city: 'Boston', country: 'USA' },
                { affiliation: '   ' },
              ],
            },
            {
              name: 'Ben Two',
              email: 'ben@two.example',
              affiliation: 'MIT',
              country: 'USA',
            },
          ],
        })
        .expect(201);
      const shown = await as(author.token)
        .get(`/submissions/${created.body.id}`)
        .expect(200);
      expect(shown.body.authors).toHaveLength(2);
      expect(shown.body.authors[0]).toMatchObject({
        name: 'Ada Author',
        affiliation: 'IIT Bombay',
        otherAffiliations: [
          {
            affiliation: 'MIT',
            department: null,
            city: 'Boston',
            country: 'USA',
          },
        ],
      });
      expect(shown.body.authors[1].otherAffiliations).toEqual([]);
    });

    it('numbers papers per conference', async () => {
      const { conferenceId, author } = await submitted();
      const second = await as(author.token)
        .post(
          `/conferences/${conferenceId}/submissions`,
          paper([{ name: 'Ada', email: author.email, corresponding: true }], {
            title: 'Another paper',
          }),
        )
        .expect(201);
      expect(second.body.paperId).toBe('ICX-2');
    });

    it('refuses authors while the CFP is not published; a chair may still submit on their behalf', async () => {
      const chair = await person();
      const author = await person();
      const conferenceId = await openConference(chair, { publish: false });
      const body = paper([
        { name: 'Ada', email: author.email, corresponding: true },
      ]);
      const refused = await as(author.token)
        .post(`/conferences/${conferenceId}/submissions`, body)
        .expect(422);
      expect(refused.body.message).toMatch(/Call for Papers isn't published/);
      // A chair never sends their own paper to their conference (on anyone's behalf only).
      await as(chair.token)
        .post(`/conferences/${conferenceId}/submissions`, body)
        .expect(403);
      await as(chair.token)
        .post(`/conferences/${conferenceId}/submissions`, {
          ...body,
          onBehalf: true,
        })
        .expect(201);
    });

    it("refuses a chair's own paper to their conference (the CFP link); on behalf still works", async () => {
      const chair = await person();
      const author = await person();
      const conferenceId = await openConference(chair);
      const url = `/conferences/${conferenceId}/submissions`;
      const own = await as(chair.token)
        .post(
          url,
          paper([
            { name: 'Carla Chair', email: chair.email, corresponding: true },
          ]),
        )
        .expect(403);
      expect(own.body).toMatchObject({
        code: 'OWN_CONFERENCE',
        message:
          "You're a chair of this conference, so you can't submit your own paper to it. To add a paper for an author, use Submit on behalf.",
      });
      const count = async () =>
        (
          await t.db.query<{ n: number }>(
            'select count(*)::int n from submissions where conference_id = $1',
            [conferenceId],
          )
        ).rows[0].n;
      expect(await count()).toBe(0);

      const forAuthor = paper([
        { name: 'Ada', email: author.email, corresponding: true },
      ]);
      await as(chair.token)
        .post(url, { ...forAuthor, onBehalf: true })
        .expect(201);
      await as(author.token)
        .post(url, { ...forAuthor, title: 'An author’s own paper' })
        .expect(201);
      expect(await count()).toBe(2);
    });

    it('lets a chair submit on behalf in an archived conference with a closed CFP, but not in one never approved', async () => {
      const chair = await person({ firstName: 'Carla', lastName: 'Chair' });
      const author = await person();
      const conferenceId = await openConference(chair, {
        deadline: '2020-01-01T00:00:00Z',
      });
      await as(chair.token)
        .post(`/conferences/${conferenceId}/cfp/close`)
        .expect(200);
      await as(chair.token)
        .post(`/conferences/${conferenceId}/archive`)
        .expect(200);
      const body = paper([
        { name: 'Ada', email: author.email, corresponding: true },
      ]);
      // The author cannot, the chair on their behalf can.
      await as(author.token)
        .post(`/conferences/${conferenceId}/submissions`, body)
        .expect((r) => expect([404, 422]).toContain(r.status));
      const behalf = await as(chair.token)
        .post(`/conferences/${conferenceId}/submissions`, {
          ...body,
          onBehalf: true,
        })
        .expect(201);
      expect(behalf.body).toMatchObject({ view: 'chair' });
      // The form (tracks, types) of an archived conference is still there for that.
      const slug = (
        await t.db.query<{ slug: string }>(
          'select slug from conferences where id = $1',
          [conferenceId],
        )
      ).rows[0].slug;
      await http()
        .get(api(`/public/conferences/${slug}/submission-form`))
        .expect(200);

      // A conference still waiting for approval takes no paper, not even from its chair.
      const waiting = await as(chair.token)
        .post('/conferences', {
          acronym: 'WAIT 2027',
          title: 'Waiting Conference 2027',
          startDate: '2027-06-01',
          endDate: '2027-06-03',
        })
        .expect(201);
      const no = await as(chair.token)
        .post(`/conferences/${waiting.body.id}/submissions`, {
          ...body,
          onBehalf: true,
        })
        .expect((r) => expect([404, 422]).toContain(r.status));
      expect(no.status).not.toBe(201);
    });

    it('closes for authors at the deadline; a chair may still submit on their behalf', async () => {
      const chair = await person({ firstName: 'Carla', lastName: 'Chair' });
      const author = await person();
      const conferenceId = await openConference(chair, {
        deadline: '2020-01-01T00:00:00Z',
      });
      const body = paper([
        { name: 'Ada', email: author.email, corresponding: true },
      ]);
      const late = await as(author.token)
        .post(`/conferences/${conferenceId}/submissions`, body)
        .expect(422);
      expect(late.body.message).toBe('The submission deadline has passed.');

      const behalf = await as(chair.token)
        .post(`/conferences/${conferenceId}/submissions`, {
          ...body,
          onBehalf: true,
        })
        .expect(201);
      // The chair submitted it for the author: it isn't one of the chair's own papers.
      expect(behalf.body).toMatchObject({
        view: 'chair',
        mySubmission: false,
        myPaper: false,
      });
      await t.sendQueuedEmails();
      expect(await templatesTo(author.email)).toEqual([
        { template_key: 'submittedOnBehalf', status: 'sent' },
      ]);
    });

    it('lets only chairs submit on behalf, and checks the author list', async () => {
      const chair = await person();
      const author = await person();
      const conferenceId = await openConference(chair);
      const url = `/conferences/${conferenceId}/submissions`;
      await as(author.token)
        .post(url, {
          ...paper([{ name: 'Ada', email: author.email, corresponding: true }]),
          onBehalf: true,
        })
        .expect(403);
      const twice = await as(author.token)
        .post(
          url,
          paper([
            { name: 'Ada', email: author.email, corresponding: true },
            { name: 'Ada again', email: author.email.toUpperCase() },
          ]),
        )
        .expect(400);
      expect(twice.body.message).toMatch(/same email/);
      const noCorresponding = await as(author.token)
        .post(url, paper([{ name: 'Ada', email: author.email }]))
        .expect(400);
      expect(noCorresponding.body.message).toMatch(/corresponding/);
      await as(author.token).post(url, paper([])).expect(400);
    });

    it('finds a duplicate title, ignoring case and punctuation', async () => {
      const { conferenceId, author } = await submitted();
      const other = await person();
      const check = (token: string, title: string) =>
        as(token)
          .get(
            `/conferences/${conferenceId}/submissions/duplicate-check?title=${encodeURIComponent(title)}`,
          )
          .expect(200);
      expect(
        (await check(author.token, 'GRAPH networks, for protein-folding!'))
          .body,
      ).toEqual({ found: true, mine: true });
      expect(
        (await check(other.token, 'Graph networks for protein folding')).body,
      ).toEqual({ found: true, mine: false });
      expect((await check(other.token, 'Something else')).body).toEqual({
        found: false,
        mine: false,
      });
    });
  });

  describe('seeing papers', () => {
    it('shows a paper to its authors and chairs, and 404 to anyone else', async () => {
      const { chair, coAuthor, submission } = await submitted();
      const outsider = await person();
      await as(outsider.token).get(`/submissions/${submission.id}`).expect(404);
      const co = await as(coAuthor.token)
        .get(`/submissions/${submission.id}`)
        .expect(200);
      expect(co.body).toMatchObject({
        view: 'author',
        mySubmission: false,
        myCorresponding: false,
        can: { editDetails: true, editAuthors: false },
      });
      const asChair = await as(chair.token)
        .get(`/submissions/${submission.id}`)
        .expect(200);
      expect(asChair.body).toMatchObject({
        view: 'chair',
        can: { decide: true },
      });
    });

    it('lists my papers, and a conference list per role', async () => {
      const { chair, author, coAuthor, conferenceId } = await submitted();
      expect(
        (await as(author.token).get('/submissions').expect(200)).body,
      ).toHaveLength(1);
      expect(
        (await as(coAuthor.token).get('/submissions').expect(200)).body,
      ).toHaveLength(1);
      expect(
        (
          await as(chair.token)
            .get(`/conferences/${conferenceId}/submissions`)
            .expect(200)
        ).body,
      ).toHaveLength(1);
      expect(
        (
          await as(coAuthor.token)
            .get(`/conferences/${conferenceId}/submissions`)
            .expect(200)
        ).body,
      ).toHaveLength(1);
    });

    it('hides the authors from an assigned reviewer under double-blind review', async () => {
      const { conferenceId, submission } = await submitted();
      const reviewer = await person();
      await t.db.query(
        `insert into conference_members (conference_id, user_id, role, status) values ($1, $2, 'reviewer', 'active')`,
        [conferenceId, reviewer.id],
      );
      await as(reviewer.token).get(`/submissions/${submission.id}`).expect(404);
      await t.db.query(
        `insert into review_assignments (submission_id, reviewer_id, status) values ($1, $2, 'accepted')`,
        [submission.id, reviewer.id],
      );
      const seen = await as(reviewer.token)
        .get(`/submissions/${submission.id}`)
        .expect(200);
      expect(seen.body).toMatchObject({
        view: 'reviewer',
        authors: null,
        screening: null,
      });
      const list = await as(reviewer.token)
        .get(`/conferences/${conferenceId}/submissions`)
        .expect(200);
      expect(list.body).toHaveLength(1);

      await t.db.query(
        `update conferences set review_mode = 'single_blind' where id = $1`,
        [conferenceId],
      );
      const single = await as(reviewer.token)
        .get(`/submissions/${submission.id}`)
        .expect(200);
      expect(single.body.authors).toHaveLength(3);
    });
  });

  describe('changing a paper', () => {
    it('lets the authors edit the details until there is a decision', async () => {
      const { chair, coAuthor, submission } = await submitted();
      const edited = await as(coAuthor.token)
        .patch(`/submissions/${submission.id}`, {
          title: 'A better title',
          abstract: 'Shorter.',
          keywords: ['GNN'],
        })
        .expect(200);
      expect(edited.body).toMatchObject({
        title: 'A better title',
        keywords: ['GNN'],
      });

      // The track can be changed here too; left out, it stays.
      const before = edited.body.track;
      const moved = await as(coAuthor.token)
        .patch(`/submissions/${submission.id}`, {
          title: 'A better title',
          abstract: 'Shorter.',
          keywords: ['GNN'],
          track: 'Machine Learning',
        })
        .expect(200);
      expect(moved.body.track).toBe('Machine Learning');
      expect(before).not.toBe('Machine Learning');
      const kept = await as(coAuthor.token)
        .patch(`/submissions/${submission.id}`, {
          title: 'A better title',
          abstract: 'Shorter.',
          keywords: ['GNN'],
        })
        .expect(200);
      expect(kept.body.track).toBe('Machine Learning');

      const types = await t.db.query<{ id: string; outcome: string }>(
        'select id, outcome from decision_types where conference_id = $1',
        [submission.conferenceId],
      );
      const accept = types.rows.find((r) => r.outcome === 'accept')!;
      await as(chair.token)
        .post(`/submissions/${submission.id}/decision`, {
          decisionTypeId: accept.id,
        })
        .expect(200);
      const late = await as(coAuthor.token)
        .patch(`/submissions/${submission.id}`, {
          title: 'x',
          abstract: 'y',
          keywords: ['test'],
        })
        .expect(422);
      expect(late.body.message).toBe('This paper can no longer be changed.');
      // The chair hasn't sent the decision: the author still sees "under review".
      const asAuthor = await as(coAuthor.token)
        .get(`/submissions/${submission.id}`)
        .expect(200);
      expect(asAuthor.body).toMatchObject({
        outcome: 'no_decision',
        decisionTypeId: null,
      });
    });

    it('lets a chair edit a paper they submitted for an author only until an author claims it', async () => {
      const chair = await person({ firstName: 'Carla', lastName: 'Chair' });
      const conferenceId = await openConference(chair);
      const created = await as(chair.token)
        .post(`/conferences/${conferenceId}/submissions`, {
          ...paper([
            {
              name: 'Una Unclaimed',
              email: 'una@new.example',
              corresponding: true,
            },
          ]),
          onBehalf: true,
        })
        .expect(201);
      const id = created.body.id as string;
      await as(chair.token)
        .patch(`/submissions/${id}`, {
          title: 'Fixed title',
          abstract: 'Fixed.',
          keywords: ['test'],
        })
        .expect(200);
      // Una registers: the paper is linked to her account, and now it's hers to edit.
      const una = await t.createUser({ email: 'una@new.example' });
      await t.db.query(
        `update submission_authors set user_id = $1 where lower(email) = 'una@new.example'`,
        [una.id],
      );
      await as(chair.token)
        .patch(`/submissions/${id}`, {
          title: 'Again',
          abstract: 'Again.',
          keywords: ['test'],
        })
        .expect(403);
      await as(await t.tokenFor(una.id))
        .patch(`/submissions/${id}`, {
          title: 'Mine now',
          abstract: 'Mine.',
          keywords: ['test'],
        })
        .expect(200);
    });

    it('replaces the author list and emails only the new authors', async () => {
      const { author, coAuthor, submission } = await submitted();
      await t.sendQueuedEmails();
      t.outbox().length = 0;
      const res = await as(author.token)
        .put(`/submissions/${submission.id}/authors`, {
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
              name: 'Cole Coauthor',
              email: coAuthor.email,
            },
            {
              affiliation: 'Test University',
              country: 'India',
              name: 'Pia Plus',
              email: 'pia@new.example',
              corresponding: true,
            },
          ],
        })
        .expect(200);
      expect(res.body.authors.map((a: { email: string }) => a.email)).toEqual([
        author.email,
        coAuthor.email,
        'pia@new.example',
      ]);
      await t.sendQueuedEmails();
      expect(
        sent()
          .map((m) => m.to)
          .sort(),
      ).toEqual(['pia@new.example', 'pia@new.example']);
      expect(
        (await templatesTo('pia@new.example'))
          .map((r) => r.template_key)
          .sort(),
      ).toEqual(['coAuthorAdded', 'welcome']);
      // A co-author is not the submitter: the list is not theirs to change.
      await as(coAuthor.token)
        .put(`/submissions/${submission.id}/authors`, {
          authors: [
            {
              affiliation: 'Test University',
              city: 'Pune',
              country: 'India',
              name: 'Cole',
              email: coAuthor.email,
              corresponding: true,
            },
          ],
        })
        .expect(403);
    });

    it('withdraws once, takes the paper out of review and tells the others', async () => {
      const { chair, author, coAuthor, submission } = await submitted();
      const reviewer = await person();
      await t.db.query(
        `insert into review_assignments (submission_id, reviewer_id, status) values ($1, $2, 'accepted')`,
        [submission.id, reviewer.id],
      );
      await t.sendQueuedEmails();
      const res = await as(coAuthor.token)
        .post(`/submissions/${submission.id}/withdraw`)
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'withdrawn',
        withdrawnBy: 'author',
        can: { withdraw: false, editDetails: false },
      });
      const assignment = await t.db.query<{ status: string }>(
        'select status from review_assignments where submission_id = $1',
        [submission.id],
      );
      expect(assignment.rows[0].status).toBe('removed');
      expect(await bell(author.id)).toContain('withdrawn');
      expect(await bell(coAuthor.id)).not.toContain('withdrawn');
      await t.sendQueuedEmails();
      expect((await templatesTo(chair.email)).at(-1)).toEqual({
        template_key: 'submissionWithdrawn',
        status: 'sent',
      });
      expect((await templatesTo(author.email)).at(-1)?.template_key).toBe(
        'submissionWithdrawn',
      );

      const again = await as(author.token)
        .post(`/submissions/${submission.id}/withdraw`)
        .expect(422);
      expect(again.body.message).toBe('This paper has already been withdrawn.');
    });
  });

  describe('screening and stages', () => {
    it('saves the screening record and emails the authors the correction request', async () => {
      const { chair, author, coAuthor, submission } = await submitted();
      // Version 1 of the paper, to screen.
      await http()
        .post(api(`/submissions/${submission.id}/files`))
        .set('Authorization', `Bearer ${author.token}`)
        .attach('file', Buffer.from('%PDF-1.7\n%%EOF\n'), 'paper.pdf')
        .expect(201);
      const url = `/submissions/${submission.id}/screening/1`;
      const early = await as(chair.token)
        .post(`${url}/notify`, { stage: 'correction' })
        .expect(422);
      expect(early.body.message).toMatch(/Save the screening decision/);

      await as(author.token)
        .put(url, { record: { check: {} } })
        .expect(403);
      const saved = await as(chair.token)
        .put(url, {
          record: {
            check: { comment: 'Please use the template.' },
            correction: { reasons: ['Wrong template'], deadline: '2027-04-01' },
          },
        })
        .expect(200);
      expect(saved.body.screening['1'].correction.reasons).toEqual([
        'Wrong template',
      ]);

      await t.sendQueuedEmails();
      t.outbox().length = 0;
      const notice = await as(chair.token)
        .post(`${url}/notify`, { stage: 'correction', coAuthors: true })
        .expect(200);
      expect(notice.body).toEqual({ queued: 3, skipped: 0 });
      await t.sendQueuedEmails();
      const toAuthor = t.outbox().find((m) => m.to === author.email)!;
      expect(toAuthor.text).toContain('Wrong template');
      expect(toAuthor.text).toContain('1 Apr 2027');
      expect((await templatesTo(coAuthor.email)).at(-1)?.template_key).toBe(
        'screeningCoAuthor',
      );
      expect(await bell(author.id)).toContain('screening');

      // The author sees the screening record; the automatic check is the chair's.
      const asAuthor = await as(author.token)
        .get(`/submissions/${submission.id}`)
        .expect(200);
      expect(asAuthor.body.screening['1'].correction).toBeDefined();
    });

    it('records a stage the authors see as it is (plagiarism clear)', async () => {
      const { chair, author, submission } = await submitted();
      const types = await t.db.query<{ id: string }>(
        `select id from decision_types where conference_id = $1 and outcome = 'plagiarism_clear'`,
        [submission.conferenceId],
      );
      await as(author.token)
        .post(`/submissions/${submission.id}/decision`, {
          decisionTypeId: types.rows[0].id,
        })
        .expect(403);
      const res = await as(chair.token)
        .post(`/submissions/${submission.id}/decision`, {
          decisionTypeId: types.rows[0].id,
        })
        .expect(200);
      expect(res.body.outcome).toBe('plagiarism_clear');
      const asAuthor = await as(author.token)
        .get(`/submissions/${submission.id}`)
        .expect(200);
      expect(asAuthor.body.outcome).toBe('plagiarism_clear');
      const events = await t.db.query(
        'select outcome from decision_events where submission_id = $1',
        [submission.id],
      );
      expect(events.rows).toEqual([{ outcome: 'plagiarism_clear' }]);
    });
  });

  describe('the email queue', () => {
    it('skips an email the conference turned off', async () => {
      const chair = await person();
      const author = await person();
      const conferenceId = await openConference(chair);
      await t.db.query(
        `update conference_email_templates set enabled = false where conference_id = $1 and key = 'submissionReceived'`,
        [conferenceId],
      );
      await as(author.token)
        .post(
          `/conferences/${conferenceId}/submissions`,
          paper([{ name: 'Ada', email: author.email, corresponding: true }]),
        )
        .expect(201);
      expect(await templatesTo(author.email)).toEqual([]);
    });

    it('retries a failed email later, then marks it failed after the last attempt', async () => {
      const { author } = await submitted();
      const transport = t.app.get(
        (await import('../src/core/email/email.transport.js')).EmailTransport,
      );
      const original = transport.send.bind(transport);
      transport.send = () => Promise.reject(new Error('Mailbox unavailable'));
      try {
        await expect(t.sendQueuedEmails()).resolves.toEqual({
          sent: 0,
          failed: 0,
        });
        const [row] = (
          await t.db.query<{
            status: string;
            attempts: number;
            error: string;
            later: boolean;
          }>(
            `select status, attempts, error, next_attempt_at > now() as later from email_log where to_email = $1`,
            [author.email],
          )
        ).rows;
        expect(row).toEqual({
          status: 'queued',
          attempts: 1,
          error: 'Mailbox unavailable',
          later: true,
        });

        // Not due yet: nothing happens. Then the last attempts fail for good.
        await expect(t.sendQueuedEmails()).resolves.toEqual({
          sent: 0,
          failed: 0,
        });
        for (let i = 0; i < 4; i += 1) {
          await t.db.query(
            `update email_log set next_attempt_at = now() where status = 'queued'`,
          );
          await t.sendQueuedEmails();
        }
        expect(await templatesTo(author.email)).toEqual([
          { template_key: 'submissionReceived', status: 'failed' },
        ]);
      } finally {
        transport.send = original;
      }
    });
  });
  describe('author emails, duplicate titles and on-behalf papers', () => {
    const url = (id: string) => `/conferences/${id}/submissions`;
    const none = null as unknown as string;

    it('needs the submitter and one co-author email; the others can come later', async () => {
      const chair = await person();
      const author = await person();
      const conferenceId = await openConference(chair);
      const only = (emails: string[]) =>
        paper(
          emails.map((email, i) => ({
            name: `Author ${i + 1}`,
            email,
            corresponding: i === 0,
          })),
        );

      // A paper with co-authors: one co-author email at least, as well as the submitter's.
      const short = await as(author.token)
        .post(url(conferenceId), only([author.email, none, none]))
        .expect(400);
      expect(short.body.message).toBe(
        'Give the email of at least one co-author as well as your own. The others can be added later.',
      );
      const made = await as(author.token)
        .post(url(conferenceId), only([author.email, 'b@x.example', none]))
        .expect(201);
      expect(made.body.authors.map((a: { email: unknown }) => a.email)).toEqual(
        [author.email, 'b@x.example', null],
      );

      // A one-author paper needs only the author's own email.
      await as(author.token)
        .post(url(conferenceId), {
          ...only([author.email]),
          title: 'A paper written alone',
        })
        .expect(201);

      // Nobody is emailed at an address that isn't there.
      await t.sendQueuedEmails();
      expect(t.outbox().every((m) => typeof m.to === 'string' && m.to)).toBe(
        true,
      );
    });

    it('needs a chosen corresponding author, with an email', async () => {
      const chair = await person();
      const author = await person();
      const conferenceId = await openConference(chair);
      const nobody = await as(author.token)
        .post(
          url(conferenceId),
          paper([
            { name: 'Ada', email: author.email },
            { name: 'Bo', email: 'bo@x.example' },
          ]),
        )
        .expect(400);
      expect(nobody.body.message).toBe('Choose the corresponding author.');

      const noEmail = await as(chair.token)
        .post(url(conferenceId), {
          ...paper([{ name: 'Ada', email: none, corresponding: true }]),
          onBehalf: true,
        })
        .expect(400);
      expect(noEmail.body.message).toBe(
        'Author 1 is a corresponding author, so they need an email.',
      );
    });

    it("on behalf: only the corresponding author needs an email, and the paper is not the chair's", async () => {
      const chair = await person();
      const author = await person();
      const conferenceId = await openConference(chair);
      const made = await as(chair.token)
        .post(url(conferenceId), {
          ...paper([
            { name: 'Ada', email: author.email, corresponding: true },
            { name: 'Bo', email: none },
            { name: 'Cy', email: none },
          ]),
          onBehalf: true,
        })
        .expect(201);
      expect(made.body).toMatchObject({ mySubmission: false, myPaper: false });

      // Not in the chair's own papers, their author role or their author activity log...
      expect(
        (await as(chair.token).get('/submissions').expect(200)).body,
      ).toEqual([]);
      const conferences = await as(chair.token)
        .get('/me/conferences')
        .expect(200);
      expect(JSON.stringify(conferences.body)).not.toMatch(/"author"/);
      expect(
        (
          await as(chair.token)
            .get(`/conferences/${conferenceId}/my-activity?role=author`)
            .expect(200)
        ).body,
      ).toEqual([]);

      // ...but the author's.
      const authorView = await as(author.token).get('/submissions').expect(200);
      expect(authorView.body).toHaveLength(1);
      expect(authorView.body[0]).toMatchObject({ myPaper: true });
      const log = await as(author.token)
        .get(`/conferences/${conferenceId}/my-activity?role=author`)
        .expect(200);
      expect(
        (log.body as { description: string }[]).map((e) => e.description),
      ).toContain('Submitted ICX-1.');
    });

    it("a co-author's email added later links their account and tells them", async () => {
      const chair = await person();
      const author = await person();
      const later = await person({ firstName: 'Lena', lastName: 'Later' });
      const conferenceId = await openConference(chair);
      const made = await as(author.token)
        .post(
          url(conferenceId),
          paper([
            { name: 'Ada', email: author.email, corresponding: true },
            { name: 'Bo', email: 'bo@x.example' },
            { name: 'Lena Later', email: none },
          ]),
        )
        .expect(201);
      await t.sendQueuedEmails();
      t.outbox().length = 0;
      expect(
        (await as(later.token).get('/submissions').expect(200)).body,
      ).toEqual([]);

      const authors = (
        made.body.authors as {
          name: string;
          email: string | null;
          corresponding: boolean;
        }[]
      ).map((a) => ({
        name: a.name,
        email: a.name === 'Lena Later' ? later.email : (a.email as string),
        corresponding: a.corresponding,
      }));
      await as(author.token)
        .put(`/submissions/${made.body.id}/authors`, {
          authors: withPlace(authors),
        })
        .expect(200);
      await t.sendQueuedEmails();
      expect(t.outbox().map((m) => m.to)).toEqual([later.email]);
      expect(
        (await as(later.token).get('/submissions').expect(200)).body,
      ).toHaveLength(1);
    });

    it('refuses a title another paper of the conference already has, on submit and on edit', async () => {
      const chair = await person();
      const author = await person();
      const conferenceId = await openConference(chair);
      const two = (title: string) => ({
        ...paper([
          { name: 'Ada', email: author.email, corresponding: true },
          { name: 'Bo', email: 'bo@x.example' },
        ]),
        title,
      });
      const first = await as(author.token)
        .post(url(conferenceId), two('Graph networks for protein folding'))
        .expect(201);
      const again = await as(author.token)
        .post(url(conferenceId), two('GRAPH networks, for protein-folding!'))
        .expect(409);
      expect(again.body).toMatchObject({
        code: 'DUPLICATE_TITLE',
        message:
          'A paper with this title is already submitted to this conference. Please use a different title.',
        details: [
          { field: 'title', errors: ['already used by another paper'] },
        ],
      });

      const second = await as(author.token)
        .post(url(conferenceId), two('Another paper'))
        .expect(201);
      await as(author.token)
        .patch(`/submissions/${second.body.id}`, {
          title: 'Graph Networks for Protein Folding',
          abstract: 'x',
          keywords: ['test'],
        })
        .expect(409);
      // A paper keeps its own title, and a withdrawn paper's title is free again.
      await as(author.token)
        .patch(`/submissions/${first.body.id}`, {
          title: 'Graph networks for protein folding',
          abstract: 'Shorter.',
          keywords: ['test'],
        })
        .expect(200);
      await as(author.token)
        .post(`/submissions/${first.body.id}/withdraw`, {})
        .expect(200);
      await as(author.token)
        .patch(`/submissions/${second.body.id}`, {
          title: 'Graph networks for protein folding',
          abstract: 'x',
          keywords: ['test'],
        })
        .expect(200);
    });
  });
});
