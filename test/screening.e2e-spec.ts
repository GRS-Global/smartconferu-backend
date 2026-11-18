import request from 'supertest';
import {
  createTestApp,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

/** Enough of a PDF for the type check (the API doesn't read papers; the app does). */
const pdf = (tag = 'paper') => Buffer.from(`%PDF-1.7\n% ${tag}\n%%EOF\n`);
/** A .docx starts like any ZIP file. */
const docx = () =>
  Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 1)]);

/** A result as the app's automatic check produces it (src/chair-plagiarism/autoCheck.js). */
function result(over: Record<string, unknown> = {}) {
  return {
    status: 'done',
    pages: 10,
    editable: true,
    english: true,
    column: 'single',
    confidence: { column: 'high', english: 'high' },
    source: { column: 'rules', english: 'rules' },
    missing: [],
    at: new Date().toISOString(),
    ...over,
  };
}

describe('Paper files, screening settings and AI mode', () => {
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
    upload: (
      submissionId: string,
      data: Buffer,
      name: string,
      fields: { supplementary?: boolean; autoCheck?: object | string } = {},
    ) => {
      let req = http()
        .post(api(`/submissions/${submissionId}/files`))
        .set('Authorization', `Bearer ${token}`)
        .attach('file', data, name);
      if (fields.supplementary) req = req.field('supplementary', 'true');
      if (fields.autoCheck) {
        req = req.field(
          'autoCheck',
          typeof fields.autoCheck === 'string'
            ? fields.autoCheck
            : JSON.stringify(fields.autoCheck),
        );
      }
      return req;
    },
  });

  /** A live conference with a published CFP, a paper by `author`, and its chair. */
  async function setup({
    aiMode = false,
    failMode = 'send_back' as 'send_back' | 'leave',
  } = {}) {
    const chair = await person({ firstName: 'Carla', lastName: 'Chair' });
    const author = await person({ firstName: 'Ada', lastName: 'Author' });
    const admin = await person();
    await t.db.query('update users set is_super_admin = true where id = $1', [
      admin.id,
    ]);
    await t.db.query(
      `insert into user_mfa (user_id, totp_secret, enabled_at) values ($1, 'x', now())`,
      [admin.id],
    );
    const created = await as(chair.token)
      .post('/conferences', {
        acronym: 'ICX 2027',
        title: 'International Conference X 2027',
      })
      .expect(201);
    const conferenceId = created.body.id as string;
    await as(await t.tokenFor(admin.id, true))
      .post(`/admin/conferences/${conferenceId}/decision`, { approve: true })
      .expect(204);
    await as(chair.token)
      .post(`/conferences/${conferenceId}/cfp/publish`)
      .expect(200);
    await as(await t.tokenFor(admin.id, true))
      .post(`/admin/conferences/${conferenceId}/cfp/decision`, {
        approve: true,
      })
      .expect(204);
    if (aiMode) {
      await as(chair.token)
        .put(`/conferences/${conferenceId}/screening-settings`, {
          settings: { autoInitialCheck: true, autoInitialFail: failMode },
        })
        .expect(200);
    }
    const paper = await as(author.token)
      .post(`/conferences/${conferenceId}/submissions`, {
        title: 'Graph networks for protein folding',
        abstract: 'We show that graph networks fold proteins.',
        authors: [
          { name: 'Ada Author', email: author.email, corresponding: true },
        ],
      })
      .expect(201);
    await t.sendQueuedEmails();
    t.outbox().length = 0;
    return {
      chair,
      author,
      conferenceId,
      submissionId: paper.body.id as string,
    };
  }

  const uploadChecked = async (
    token: string,
    submissionId: string,
    check: Record<string, unknown> = {},
  ) =>
    (
      await as(token)
        .upload(submissionId, pdf(), 'paper.pdf', { autoCheck: result(check) })
        .expect(201)
    ).body as {
      fileId: string;
      version: number;
      autoCheck: { decision?: { outcome: string; reason?: string } } | null;
    };

  const record = async (submissionId: string, version = 1) =>
    (
      await t.db.query<{ r: Record<string, unknown> | null }>(
        `select screening -> $2::text as r from submissions where id = $1`,
        [submissionId, String(version)],
      )
    ).rows[0].r as {
      check?: Record<string, unknown>;
      correction?: { reasons?: string[] };
    } | null;

  const storedCheck = async (fileId: string) =>
    (
      await t.db.query<{ auto_check: Record<string, unknown> | null }>(
        'select auto_check from submission_files where id = $1',
        [fileId],
      )
    ).rows[0].auto_check as {
      decision?: { outcome: string; reason?: string };
      missing?: string[];
    } | null;

  describe('uploading', () => {
    it('stores each paper version, moves the paper under review and lets readers download it', async () => {
      const { author, chair, submissionId } = await setup();
      const file = pdf('first');
      const first = await as(author.token)
        .upload(submissionId, file, 'my paper.pdf')
        .expect(201);
      expect(first.body).toMatchObject({
        kind: 'paper',
        version: 1,
        fileName: 'my paper.pdf',
        autoCheck: null,
      });
      const paper = await as(author.token)
        .get(`/submissions/${submissionId}`)
        .expect(200);
      expect(paper.body.outcome).toBe('no_decision');
      expect(paper.body.files).toHaveLength(1);

      const second = await uploadChecked(author.token, submissionId);
      expect(second.version).toBe(2);
      const bell = await t.db.query<{ kind: string }>(
        'select kind from notifications where user_id = $1',
        [chair.id],
      );
      expect(bell.rows.map((r) => r.kind)).toContain('new_version');

      const download = await as(chair.token)
        .get(`/submissions/${submissionId}/files/${first.body.fileId}`)
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(download.headers['content-type']).toBe('application/pdf');
      expect(Buffer.compare(download.body as Buffer, file)).toBe(0);
    });

    it('checks the type by content, not only the name, and refuses outsiders and withdrawn papers', async () => {
      const { author, submissionId } = await setup();
      const fake = await as(author.token)
        .upload(submissionId, Buffer.from('not a PDF at all'), 'paper.pdf')
        .expect(400);
      expect(fake.body.message).toBe('Only PDF or Word files can be uploaded.');
      await as(author.token)
        .upload(submissionId, pdf(), 'paper.txt')
        .expect(400);
      // A ZIP is fine as supplementary material, never as the paper.
      await as(author.token)
        .upload(submissionId, docx(), 'extra.zip')
        .expect(400);
      const extra = await as(author.token)
        .upload(submissionId, docx(), 'extra.zip', { supplementary: true })
        .expect(201);
      expect(extra.body.kind).toBe('supplementary');
      await as(author.token)
        .upload(submissionId, docx(), 'paper.docx')
        .expect(201);

      const outsider = await person();
      await as(outsider.token).upload(submissionId, pdf(), 'p.pdf').expect(404);
      await as(outsider.token)
        .get(`/submissions/${submissionId}/files/${extra.body.fileId}`)
        .expect(404);

      await as(author.token)
        .post(`/submissions/${submissionId}/withdraw`)
        .expect(200);
      const late = await as(author.token)
        .upload(submissionId, pdf(), 'p.pdf')
        .expect(422);
      expect(late.body.message).toMatch(/withdrawn/);
    });

    it('refuses a malformed check result from the app, and keeps a valid one as sent', async () => {
      const { author, submissionId } = await setup();
      const bad = await as(author.token)
        .upload(submissionId, pdf(), 'p.pdf', {
          autoCheck: { status: 'done', pages: 0, editable: 'yes' },
        })
        .expect(400);
      expect(bad.body.details.problems).toEqual([
        expect.stringMatching(/pages/),
        expect.stringMatching(/editable/),
      ]);
      await as(author.token)
        .upload(submissionId, pdf(), 'p.pdf', { autoCheck: '{oops' })
        .expect(400);
      // Nothing was stored for the refused uploads.
      expect(
        (await t.db.query('select id from submission_files')).rows,
      ).toHaveLength(0);

      const ok = await uploadChecked(author.token, submissionId, {
        decision: { outcome: 'passed' },
      });
      // The client's own "decision" is never taken; AI mode is off, so nothing is decided.
      expect(ok.autoCheck).toMatchObject({ status: 'done', pages: 10 });
      expect(ok.autoCheck).not.toHaveProperty('decision');
      expect(await record(submissionId)).toBeNull();
    });
  });

  describe('screening settings', () => {
    it('returns the defaults and saves valid changes (chairs only)', async () => {
      const { chair, author, conferenceId } = await setup();
      const url = `/conferences/${conferenceId}/screening-settings`;
      const defaults = await as(chair.token).get(url).expect(200);
      expect(defaults.body).toEqual({
        settings: {
          initialCheck: true,
          plagiarism: true,
          autoInitialCheck: false,
          autoInitialFail: 'send_back',
        },
        criteria: expect.objectContaining({
          column: 'single',
          minPages: 8,
          maxPages: 30,
        }),
        aiModeAvailable: true,
      });
      // The author sees the conference, not its settings.
      await as(author.token).get(url).expect(403);

      const saved = await as(chair.token)
        .put(url, { criteria: { column: 'double', doubleMinPages: 5 } })
        .expect(200);
      expect(saved.body.criteria).toMatchObject({
        column: 'double',
        doubleMinPages: 5,
        maxPages: 30,
      });

      await as(chair.token)
        .put(url, { criteria: { minPages: 40 } })
        .expect(400);
      await as(chair.token)
        .put(url, { criteria: { column: 'triple' } })
        .expect(400);
      await as(chair.token)
        .put(url, { settings: { autoInitialFail: 'maybe' } })
        .expect(400);
      await as(chair.token)
        .put(url, { criteria: { similarityLimit: 120 } })
        .expect(400);
      await as(chair.token).put(url, { colour: 'blue' }).expect(400);
    });
  });

  describe('screening records (manual initial check)', () => {
    it('checks a record before saving it', async () => {
      const { chair, author, submissionId } = await setup();
      const url = `/submissions/${submissionId}/screening/1`;
      const noFile = await as(chair.token)
        .put(url, { record: { check: {} } })
        .expect(400);
      expect(noFile.body.message).toBe('This paper has no file to screen yet.');

      await as(author.token)
        .upload(submissionId, pdf(), 'paper.pdf')
        .expect(201);
      await as(chair.token)
        .put(`/submissions/${submissionId}/screening/2`, { record: {} })
        .expect(400);
      const bad = await as(chair.token)
        .put(url, {
          record: {
            check: { decision: 'maybe', pages: -3, english: 'yes' },
            report: { similarity: 140 },
            paths: { 'report.pdf': 'other-conference/x/report.pdf' },
          },
        })
        .expect(400);
      expect(bad.body.details.problems).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/check.decision/),
          expect.stringMatching(/check.pages/),
          expect.stringMatching(/check.english/),
          expect.stringMatching(/report.similarity/),
          expect.stringMatching(/paths/),
          expect.stringMatching(/once the initial check has passed/),
        ]),
      );

      const saved = await as(chair.token)
        .put(url, {
          record: {
            check: {
              decision: 'passed',
              editable: true,
              english: true,
              column: 'single',
              pages: '10',
            },
            at: 'Oct 9, 2026',
          },
        })
        .expect(200);
      expect(saved.body.screening['1'].check).toMatchObject({
        decision: 'passed',
        chairSet: true,
      });
    });
  });

  describe('AI mode', () => {
    it('decides nothing when AI mode is off: the chair checks by hand', async () => {
      const { author, submissionId } = await setup();
      await uploadChecked(author.token, submissionId, { pages: 2 });
      expect(await record(submissionId)).toBeNull();
    });

    it('passes a paper that meets every requirement', async () => {
      const { author, submissionId } = await setup({ aiMode: true });
      const file = await uploadChecked(author.token, submissionId);
      expect(file.autoCheck?.decision?.outcome).toBe('passed');
      expect((await record(submissionId))?.check).toMatchObject({
        decision: 'passed',
        autoSet: true,
        editable: true,
        english: true,
        column: 'single',
        pages: '10',
      });
      await t.sendQueuedEmails();
      expect(t.outbox()).toHaveLength(0); // passing isn't emailed
    });

    it('sends back a paper in the wrong layout or too short, and decides the next version again', async () => {
      const { author, submissionId } = await setup({ aiMode: true });
      const file = await uploadChecked(author.token, submissionId, {
        pages: 3,
        column: 'double',
      });
      expect(file.autoCheck?.decision?.outcome).toBe('sent_back');
      const rec = await record(submissionId);
      expect(rec?.check).toMatchObject({ decision: 'revision', autoSet: true });
      expect(rec?.correction?.reasons).toEqual([
        'Please use the single column conference template.',
        'The paper is too short (3 pages). In double column the minimum is 4 pages.',
      ]);
      await t.sendQueuedEmails();
      const email = t.outbox().find((m) => m.to === author.email);
      expect(email?.text).toContain(
        'Please use the single column conference template.',
      );
      const bell = await t.db.query<{ kind: string }>(
        'select kind from notifications where user_id = $1',
        [author.id],
      );
      expect(bell.rows.map((r) => r.kind)).toContain('screening');

      const v2 = await uploadChecked(author.token, submissionId, { pages: 12 });
      expect(v2).toMatchObject({
        version: 2,
        autoCheck: { decision: { outcome: 'passed' } },
      });
    });

    it('sends back a scanned paper as not editable', async () => {
      const { author, submissionId } = await setup({ aiMode: true });
      await uploadChecked(author.token, submissionId, {
        editable: false,
        english: null,
        column: null,
        confidence: { column: 'low', english: 'low' },
      });
      expect((await record(submissionId))?.correction?.reasons).toEqual([
        'The paper is not editable (scanned or image-only PDF). Please upload a text-based PDF or Word file.',
      ]);
    });

    it('leaves a failing paper for the chair when the conference says so', async () => {
      const { author, submissionId } = await setup({
        aiMode: true,
        failMode: 'leave',
      });
      const file = await uploadChecked(author.token, submissionId, {
        pages: 2,
      });
      expect(file.autoCheck?.decision).toMatchObject({
        outcome: 'left_for_chair',
        reason: 'Page Count',
      });
      expect(await record(submissionId)).toBeNull();
    });

    it('leaves an unsure result, a failed check or no result for the chair', async () => {
      const { author, submissionId } = await setup({ aiMode: true });
      const unsure = await uploadChecked(author.token, submissionId, {
        confidence: { column: 'low', english: 'high' },
        aiError: 'The AI check is busy',
      });
      expect(unsure.autoCheck?.decision).toMatchObject({
        outcome: 'left_for_chair',
        reason: 'Not sure of the layout or language (The AI check is busy)',
      });

      const word = await as(author.token)
        .upload(submissionId, docx(), 'paper.docx', {
          autoCheck: {
            status: 'failed',
            error: 'Only PDF files can be checked automatically.',
          },
        })
        .expect(201);
      expect(word.body.autoCheck.decision).toMatchObject({
        outcome: 'left_for_chair',
        reason: 'Only PDF files can be checked automatically.',
      });

      const none = await as(author.token)
        .upload(submissionId, pdf(), 'p.pdf')
        .expect(201);
      expect(none.body.autoCheck).toBeNull();
      expect(await record(submissionId, 3)).toBeNull();
    });

    it('decides a result that arrives after the upload, once', async () => {
      const { author, submissionId } = await setup({ aiMode: true });
      const file = (
        await as(author.token).upload(submissionId, pdf(), 'p.pdf').expect(201)
      ).body as { fileId: string };
      const url = `/submissions/${submissionId}/files/${file.fileId}/auto-check`;
      const late = await as(author.token)
        .put(url, { autoCheck: result() })
        .expect(200);
      expect(late.body.decision.outcome).toBe('passed');
      await as(author.token)
        .put(url, { autoCheck: result({ pages: 2 }) })
        .expect(409);
      await as(author.token).put(url, {}).expect(400);
      const outsider = await person();
      await as(outsider.token).put(url, { autoCheck: result() }).expect(404);
    });

    it('drops "author names missing" under double-blind review', async () => {
      const { author, submissionId } = await setup({ aiMode: true });
      await t.db.query(`update conferences set review_mode = 'double_blind'`);
      const file = await uploadChecked(author.token, submissionId, {
        missing: ['author_names', 'affiliations', 'keywords'],
      });
      expect((await storedCheck(file.fileId))?.missing).toEqual(['keywords']);
    });

    it('never overrides a decision the chair already made', async () => {
      const { chair, author, submissionId } = await setup({ aiMode: true });
      const v1 = (
        await as(author.token).upload(submissionId, pdf(), 'p.pdf').expect(201)
      ).body as { fileId: string };
      await as(chair.token)
        .put(`/submissions/${submissionId}/screening/1`, {
          record: { check: { decision: 'hold' } },
        })
        .expect(200);
      const late = await as(author.token)
        .put(`/submissions/${submissionId}/files/${v1.fileId}/auto-check`, {
          autoCheck: result({ pages: 2 }),
        })
        .expect(200);
      expect(late.body.decision.outcome).toBe('already_decided');
      expect((await record(submissionId))?.check).toMatchObject({
        decision: 'hold',
        chairSet: true,
      });
    });

    it('only decides the newest version', async () => {
      const { author, submissionId } = await setup({ aiMode: true });
      const v1 = (
        await as(author.token).upload(submissionId, pdf(), 'p.pdf').expect(201)
      ).body as { fileId: string };
      await uploadChecked(author.token, submissionId); // v2: passed
      const late = await as(author.token)
        .put(`/submissions/${submissionId}/files/${v1.fileId}/auto-check`, {
          autoCheck: result({ pages: 2 }),
        })
        .expect(200);
      expect(late.body.decision).toBeUndefined();
      expect(await record(submissionId, 1)).toBeNull();
    });

    it('decides the waiting papers when a chair turns AI mode on later', async () => {
      const { chair, author, conferenceId, submissionId } = await setup();
      const file = await uploadChecked(author.token, submissionId);
      expect(await record(submissionId)).toBeNull();
      await as(chair.token)
        .put(`/conferences/${conferenceId}/screening-settings`, {
          settings: { autoInitialCheck: true },
        })
        .expect(200);
      expect((await storedCheck(file.fileId))?.decision?.outcome).toBe(
        'passed',
      );
      expect((await record(submissionId))?.check).toMatchObject({
        decision: 'passed',
      });
    });
  });
});
