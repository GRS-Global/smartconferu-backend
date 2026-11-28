import request from 'supertest';
import {
  createTestApp,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

describe('Notifications, email templates, Email Logs and custom emails', () => {
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
    put: (path: string, body: object) =>
      http().put(api(path)).set('Authorization', `Bearer ${token}`).send(body),
    delete: (path: string) =>
      http().delete(api(path)).set('Authorization', `Bearer ${token}`),
  });

  async function conference() {
    const chair = await person({ firstName: 'Carla', lastName: 'Chair' });
    const created = await as(chair.token)
      .post('/conferences', {
        acronym: 'ICX 2027',
        title: 'International Conference X 2027',
        startDate: '2027-06-01',
        endDate: '2027-06-03',
      })
      .expect(201);
    const conferenceId = created.body.id as string;
    const admin = await superAdmin();
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
    await t.sendQueuedEmails();
    t.outbox().length = 0;
    return { chair, admin, conferenceId };
  }

  describe('the bell', () => {
    it('pages my notifications newest first and marks them read', async () => {
      const me = await person();
      const other = await person();
      for (let i = 0; i < 5; i += 1) {
        await t.db.query(
          `insert into notifications (user_id, kind, title, created_at)
           values ($1, 'test', $2, now() - ($3 || ' minutes')::interval)`,
          [me.id, `Note ${i}`, String(i)],
        );
      }
      await t.db.query(
        `insert into notifications (user_id, kind, title) values ($1, 'test', 'Not mine')`,
        [other.id],
      );

      const first = await as(me.token)
        .get('/me/notifications?limit=2')
        .expect(200);
      expect(first.body.data.map((n: { title: string }) => n.title)).toEqual([
        'Note 0',
        'Note 1',
      ]);
      expect(first.body.unread).toBe(5);
      const second = await as(me.token)
        .get(`/me/notifications?limit=2&cursor=${first.body.nextCursor}`)
        .expect(200);
      expect(second.body.data.map((n: { title: string }) => n.title)).toEqual([
        'Note 2',
        'Note 3',
      ]);

      // Someone else's id is ignored.
      const theirs = await t.db.query<{ id: string }>(
        'select id from notifications where user_id = $1',
        [other.id],
      );
      const marked = await as(me.token)
        .post('/me/notifications/read', {
          ids: [first.body.data[0].id, theirs.rows[0].id],
        })
        .expect(200);
      expect(marked.body).toEqual({ updated: 1, unread: 4 });
      const unread = await as(me.token)
        .get('/me/notifications?unread=true')
        .expect(200);
      expect(unread.body.data).toHaveLength(4);
      await as(me.token)
        .post('/me/notifications/read')
        .expect(200)
        .expect((r) => expect(r.body).toEqual({ updated: 4, unread: 0 }));
      await as(me.token).get('/me/notifications?cursor=nonsense').expect(400);
    });

    it('puts a notification back to unread, and names its conference and paper', async () => {
      const { chair, conferenceId } = await conference();
      const author = await person();
      const paper = await as(author.token)
        .post(`/conferences/${conferenceId}/submissions`, {
          title: 'Graph networks for protein folding',
          abstract: 'We show that graph networks fold proteins.',
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
          ],
        })
        .expect(201);
      await t.db.query(
        `insert into notifications (user_id, kind, title, conference_id, submission_id)
         values ($1, 'test', 'About a paper', $2, $3)`,
        [chair.id, conferenceId, paper.body.id],
      );
      const list = await as(chair.token).get('/me/notifications').expect(200);
      const note = list.body.data.find(
        (n: { title: string }) => n.title === 'About a paper',
      );
      expect(note).toMatchObject({
        conferenceAcronym: 'ICX 2027',
        paperLabel: 'ICX-1',
      });
      expect(note.conferenceSlug).toEqual(expect.any(String));

      await as(chair.token)
        .post('/me/notifications/read', { ids: [note.id] })
        .expect(200);
      const back = await as(chair.token)
        .post('/me/notifications/unread', { ids: [note.id] })
        .expect(200);
      expect(back.body.updated).toBe(1);
      // someone else's id, and one that is not read, change nothing
      const again = await as(chair.token)
        .post('/me/notifications/unread', { ids: [note.id] })
        .expect(200);
      expect(again.body.updated).toBe(0);
      const theirs = await as(author.token)
        .post('/me/notifications/unread', { ids: [note.id] })
        .expect(200);
      expect(theirs.body.updated).toBe(0);
      await as(chair.token)
        .post('/me/notifications/unread', { ids: ['nope'] })
        .expect(400);
    });
  });

  describe('my emails', () => {
    it('lists the emails sent to my own address, and nobody else’s', async () => {
      const { chair, conferenceId } = await conference();
      const author = await person();
      await as(author.token)
        .post(`/conferences/${conferenceId}/submissions`, {
          title: 'Graph networks for protein folding',
          abstract: 'We show that graph networks fold proteins.',
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
          ],
        })
        .expect(201);
      await t.sendQueuedEmails();

      const mine = await as(author.token).get('/me/emails').expect(200);
      expect(mine.body.length).toBeGreaterThan(0);
      expect(mine.body[0]).toMatchObject({
        conferenceAcronym: 'ICX 2027',
        paperLabel: 'ICX-1',
      });
      expect(mine.body[0].subject).toEqual(expect.any(String));
      expect(mine.body[0].body).toContain('<');
      // the chair's own list holds the chair's emails, not the author's
      const chairs = await as(chair.token).get('/me/emails').expect(200);
      expect(
        chairs.body.every(
          (e: { subject: string }) => !/Submission received/i.test(e.subject),
        ),
      ).toBe(true);
    });
  });

  describe('conference email templates', () => {
    it('changes, turns off and resets an email, and keeps account emails out of reach', async () => {
      const { chair, conferenceId } = await conference();
      const list = await as(chair.token)
        .get(`/conferences/${conferenceId}/email-templates`)
        .expect(200);
      const keys = list.body.templates.map((x: { key: string }) => x.key);
      expect(keys).toContain('acceptance');
      expect(keys).not.toContain('verifyEmail');

      const changed = await as(chair.token)
        .put(`/conferences/${conferenceId}/email-templates/acceptance`, {
          subject: 'Great news about "{{paper_title}}"',
        })
        .expect(200);
      const acceptance = changed.body.templates.find(
        (x: { key: string }) => x.key === 'acceptance',
      );
      expect(acceptance).toMatchObject({
        subject: 'Great news about "{{paper_title}}"',
        customized: true,
        enabled: true,
      });

      await as(chair.token)
        .put(`/conferences/${conferenceId}/email-templates/acceptance`, {
          enabled: false,
        })
        .expect(200);
      const reset = await as(chair.token)
        .delete(`/conferences/${conferenceId}/email-templates/acceptance`)
        .expect(200);
      expect(
        reset.body.templates.find(
          (x: { key: string }) => x.key === 'acceptance',
        ),
      ).toMatchObject({ customized: false, enabled: true });

      await as(chair.token)
        .put(`/conferences/${conferenceId}/email-templates/verifyEmail`, {
          subject: 'x',
        })
        .expect(422);
      await as(chair.token)
        .put(`/conferences/${conferenceId}/email-templates/noSuchEmail`, {
          subject: 'x',
        })
        .expect(404);
      const outsider = await person();
      await as(outsider.token)
        .get(`/conferences/${conferenceId}/email-templates`)
        .expect(404);
    });

    it('creates and deletes custom emails', async () => {
      const { chair, conferenceId } = await conference();
      const created = await as(chair.token)
        .put(
          `/conferences/${conferenceId}/email-templates/custom:visa-letter`,
          {
            label: 'Visa letter',
            subject: 'Your visa letter',
            body: '<p>Dear {{first_name}}</p>',
          },
        )
        .expect(200);
      expect(created.body.customEmails).toEqual([
        expect.objectContaining({
          key: 'custom:visa-letter',
          id: 'visa-letter',
          name: 'Visa letter',
          enabled: true,
        }),
      ]);
      await as(chair.token)
        .put(`/conferences/${conferenceId}/email-templates/custom:bad key`, {
          subject: 'x',
        })
        .expect(404);
      const gone = await as(chair.token)
        .delete(
          `/conferences/${conferenceId}/email-templates/custom:visa-letter`,
        )
        .expect(200);
      expect(gone.body.customEmails).toEqual([]);
    });
  });

  describe('custom emails and Email Logs', () => {
    it('sends the chair’s email to each author once, personalised, and lists it in Email Logs', async () => {
      const { chair, conferenceId } = await conference();
      const author = await person({ firstName: 'Ada', lastName: 'Author' });
      for (const title of ['First paper', 'Second paper']) {
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
                name: 'Dr. Ada Author',
                email: author.email,
                corresponding: true,
              },
              {
                affiliation: 'Test University',
                city: 'Pune',
                country: 'India',
                name: 'Bo Coauthor',
                email: 'bo@example.test',
              },
            ],
          })
          .expect(201);
      }
      await t.sendQueuedEmails();
      t.outbox().length = 0;

      const sent = await as(chair.token)
        .post(`/conferences/${conferenceId}/emails`, {
          audiences: ['corresponding_authors', 'all_authors'],
          subject: 'Hello {{first_name}}',
          body: '<p>About: {{paper_title}}</p>',
          templateLabel: 'Programme update',
        })
        .expect(200);
      expect(sent.body).toEqual({ queued: 2, skipped: 0 });
      await t.sendQueuedEmails();
      const toAda = t.outbox().find((m) => m.to === author.email);
      expect(toAda?.subject).toBe('Hello Ada');
      expect(toAda?.text).toContain('First paper; Second paper');

      const log = await as(chair.token)
        .get(
          `/conferences/${conferenceId}/email-log?templateKey=custom&limit=1`,
        )
        .expect(200);
      expect(log.body.data).toHaveLength(1);
      expect(log.body.data[0]).toMatchObject({
        templateLabel: 'Programme update',
        status: 'sent',
        sentByName: 'Carla Chair',
      });
      expect(log.body.nextCursor).not.toBeNull();
      const next = await as(chair.token)
        .get(
          `/conferences/${conferenceId}/email-log?templateKey=custom&limit=1&cursor=${log.body.nextCursor}`,
        )
        .expect(200);
      expect(next.body.data).toHaveLength(1);
      expect(next.body.data[0].id).not.toBe(log.body.data[0].id);

      await as(author.token)
        .get(`/conferences/${conferenceId}/email-log`)
        .expect(403);
      await as(chair.token)
        .post(`/conferences/${conferenceId}/emails`, {
          audiences: ['reviewers'],
          subject: 'Hi',
          body: '<p>Hi</p>',
        })
        .expect(422);
      await as(chair.token)
        .post(`/conferences/${conferenceId}/emails`, {
          audiences: ['everyone'],
          subject: 'Hi',
          body: '<p>Hi</p>',
        })
        .expect(400);
    });

    it('leaves out an email the conference turned off', async () => {
      const { chair, conferenceId } = await conference();
      await as(chair.token)
        .put(
          `/conferences/${conferenceId}/email-templates/submissionReceived`,
          {
            enabled: false,
          },
        )
        .expect(200);
      const author = await person();
      await as(author.token)
        .post(`/conferences/${conferenceId}/submissions`, {
          title: 'A paper',
          abstract: 'An abstract.',
          keywords: ['test'],
          authors: [
            {
              affiliation: 'Test University',
              city: 'Pune',
              country: 'India',
              name: 'A',
              email: author.email,
              corresponding: true,
            },
          ],
        })
        .expect(201);
      const rows = await t.db.query(
        `select 1 from email_log where template_key = 'submissionReceived'`,
      );
      expect(rows.rows).toHaveLength(0);
    });
  });

  describe('platform templates (super admins)', () => {
    it('changes a default, moves unchanged conference copies along, and sends a test', async () => {
      const { chair, admin, conferenceId } = await conference();
      await as(chair.token)
        .put(`/conferences/${conferenceId}/email-templates/rejection`, {
          subject: 'Our own rejection subject',
        })
        .expect(200);

      const list = await as(admin.token)
        .get('/admin/email-templates')
        .expect(200);
      expect(list.body.length).toBeGreaterThan(60);
      for (const key of ['acceptance', 'rejection']) {
        await as(admin.token)
          .put(`/admin/email-templates/${key}`, {
            subject: `New ${key} subject`,
            body: '<p>New body</p>',
          })
          .expect(200);
      }
      const own = await as(chair.token)
        .get(`/conferences/${conferenceId}/email-templates`)
        .expect(200);
      const find = (key: string) =>
        own.body.templates.find((x: { key: string }) => x.key === key);
      expect(find('acceptance').subject).toBe('New acceptance subject');
      expect(find('rejection').subject).toBe('Our own rejection subject');

      await as(admin.token)
        .post('/admin/email-templates/acceptance/test', {
          subject: 'Draft for {{paper_title}}',
        })
        .expect(200);
      await t.sendQueuedEmails();
      expect(t.outbox().find((m) => m.to === admin.email)?.subject).toBe(
        '[Test] Draft for Cloud-Native Architecture Patterns for Edge Computing',
      );
      const log = await as(admin.token)
        .get('/admin/email-log?templateKey=acceptance')
        .expect(200);
      expect(log.body.data[0]).toMatchObject({ toEmail: admin.email });

      await as(chair.token).get('/admin/email-templates').expect(403);
      await as(admin.token)
        .put('/admin/email-templates/acceptance', { subject: ' ', body: 'x' })
        .expect(400);
    });
  });
});
