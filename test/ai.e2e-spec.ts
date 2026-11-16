import request from 'supertest';
import { FakeAi, textPdf } from './support/fake-ai.js';
import {
  createTestApp,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

describe('AI features (against a fake Claude and Voyage)', () => {
  let t: TestApp;
  const fake = new FakeAi();

  beforeAll(async () => {
    const url = await fake.start();
    t = await createTestApp({
      ANTHROPIC_API_KEY: 'test-key',
      ANTHROPIC_BASE_URL: url,
      VOYAGE_API_KEY: 'test-key',
      VOYAGE_BASE_URL: url,
    });
  });
  afterAll(async () => {
    await t.close();
    await fake.stop();
  });
  afterEach(async () => {
    await t.reset();
    fake.calls.length = 0;
    fake.refuse = false;
    fake.answer = () => ({});
  });

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
    upload: (submissionId: string, data: Buffer, name: string) =>
      http()
        .post(api(`/submissions/${submissionId}/files`))
        .set('Authorization', `Bearer ${token}`)
        .attach('file', data, name),
  });

  const usage = async (feature: string) =>
    (
      await t.db.query<{ status: string; input_tokens: number }>(
        'select status, input_tokens from ai_usage where feature = $1',
        [feature],
      )
    ).rows;

  const sections = [
    'Graph Networks for Protein Folding',
    'Abstract',
    ...Array(6).fill(
      'We study protein folding with graph neural networks and report accuracy on two public benchmarks.',
    ),
    '1. Introduction',
    ...Array(8).fill(
      'Protein structure prediction matters for drug design and biology, and graph models capture residue contacts well.',
    ),
    '2. Method',
    ...Array(8).fill(
      'Our model passes messages between residues for twelve rounds and is trained with a contact loss on CATH data.',
    ),
  ];

  /** A conference with one paper (a real text PDF uploaded), and its chair and author. */
  async function paperWithPdf() {
    const chair = await person();
    const author = await person();
    const admin = await t.createUser();
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
        startDate: '2027-06-01',
        endDate: '2027-06-03',
      })
      .expect(201);
    const conferenceId = created.body.id as string;
    await as(await t.tokenFor(admin.id, true))
      .post(`/admin/conferences/${conferenceId}/decision`, { approve: true })
      .expect(204);
    await as(chair.token)
      .post(`/conferences/${conferenceId}/cfp/publish`)
      .expect(200);
    const paper = await as(author.token)
      .post(`/conferences/${conferenceId}/submissions`, {
        title: 'Graph networks for protein folding',
        abstract: 'We show that graph networks fold proteins.',
        authors: [{ name: 'A', email: author.email, corresponding: true }],
      })
      .expect(201);
    const submissionId = paper.body.id as string;
    await as(author.token)
      .upload(submissionId, textPdf(sections), 'paper.pdf')
      .expect(201);
    return { chair, author, conferenceId, submissionId };
  }

  const digest = {
    summary: 'The paper applies graph networks to protein folding.',
    claims: ['Graph networks fold proteins'],
    methods: ['Message passing'],
    datasets: ['CATH'],
    limitations: [],
  };

  it('fills the submission form from the paper text and records the usage', async () => {
    const user = await person();
    fake.answer = () => ({
      title: 'Graph Networks',
      abstract: 'An abstract.',
      keywords: ['GNN'],
      authors: [
        {
          name: 'Ada',
          affiliation: 'MIT',
          country: 'United States',
          email: 'ada@mit.edu',
          corresponding: true,
        },
      ],
    });
    const res = await as(user.token)
      .post('/ai/paper-metadata', { text: 'Graph Networks\nAda, MIT' })
      .expect(200);
    expect(res.body).toMatchObject({
      title: 'Graph Networks',
      keywords: ['GNN'],
    });
    const [sent] = fake.messages();
    expect(sent.model).toBe('claude-haiku-5-5');
    expect(sent.output_config).toMatchObject({
      format: { type: 'json_schema' },
    });
    expect(await usage('paper_form_fill')).toEqual([
      { status: 'ok', input_tokens: 100 },
    ]);
  });

  it('suggests only new topics, and says when the model declines', async () => {
    const user = await person();
    fake.answer = () => ({
      topics: ['Federated Learning.', 'Edge AI', 'edge ai', 'Robotics'],
    });
    const res = await as(user.token)
      .post('/ai/topics', {
        title: 'AI Systems 2027',
        existing: ['Robotics'],
        count: 5,
      })
      .expect(200);
    expect(res.body).toEqual({ topics: ['Federated Learning', 'Edge AI'] });
    await as(user.token).post('/ai/topics', {}).expect(400);

    fake.refuse = true;
    const declined = await as(user.token)
      .post('/ai/topics', { title: 'AI Systems 2027' })
      .expect(422);
    expect(declined.body.code).toBe('AI_FAILED');
  });

  it('polishes a review into three versions', async () => {
    const user = await person();
    fake.answer = () => ({
      versions: [
        { style: 'Polished', text: 'Good paper. Clear method. Accept.' },
        { style: 'Concise', text: 'Good. Clear. Accept.' },
        {
          style: 'Structured',
          text: 'Summary: good. Strengths: clear. Verdict: accept.',
        },
      ],
      improvements: ['Fixed grammar'],
      suggestions: [],
    });
    const res = await as(user.token)
      .post('/ai/review-enhance', {
        review: 'good paper. method is clear. i would accept it.',
      })
      .expect(200);
    expect(res.body).toMatchObject({
      enhancedReview: 'Good paper. Clear method. Accept.',
      context: 'none',
      usage: { calls: 1 },
    });
    expect(res.body.versions).toHaveLength(3);
  });

  it('prepares a paper and answers questions about it for its chairs', async () => {
    const { chair, author, submissionId } = await paperWithPdf();
    await as(chair.token)
      .post(`/submissions/${submissionId}/ai/chat`, { question: 'Which data?' })
      .expect(409);

    fake.answer = () => digest;
    const ingested = await as(author.token)
      .post(`/submissions/${submissionId}/ai/ingest`)
      .expect(200);
    expect(ingested.body).toMatchObject({ digest: true });
    expect(ingested.body.chunks).toBeGreaterThan(0);
    const again = await as(chair.token)
      .post(`/submissions/${submissionId}/ai/ingest`)
      .expect(200);
    expect(again.body.skipped).toBe(true);

    fake.answer = () => 'It uses CATH data [2. Method].';
    const answer = await as(chair.token)
      .post(`/submissions/${submissionId}/ai/chat`, {
        question: 'Which data is the model trained on?',
        history: [
          {
            role: 'assistant',
            content: 'dropped: history starts with the user',
          },
        ],
      })
      .expect(200);
    expect(answer.body.answer).toBe('It uses CATH data [2. Method].');
    expect(answer.body.sources[0]).toMatchObject({ section: '2. Method' });
    const chat = fake.messages().at(-1)!;
    expect(chat.messages).toHaveLength(1);
    expect(JSON.stringify(chat.system)).toContain('Message passing');

    // Authors can't ask the assistant about their own paper.
    await as(author.token)
      .post(`/submissions/${submissionId}/ai/chat`, { question: 'Is it good?' })
      .expect(403);
    expect((await usage('paper_chat')).length).toBe(2); // embedding + answer
  });

  it('prepares papers that were missed in the background job', async () => {
    const { submissionId } = await paperWithPdf();
    fake.answer = () => digest;
    const run = await t.runJobs();
    expect(run.paperAi).toEqual({ prepared: 1, failed: 0 });
    const rows = await t.db.query(
      'select 1 from paper_digests where submission_id = $1',
      [submissionId],
    );
    expect(rows.rows).toHaveLength(1);
    expect((await t.runJobs()).paperAi).toEqual({ prepared: 0, failed: 0 });
  });

  it('refuses to read websites on private addresses', async () => {
    const user = await person();
    const res = await as(user.token)
      .post('/ai/conference-from-website', { url: 'http://127.0.0.1:8080/' })
      .expect(422);
    expect(res.body.message).toBe("That address isn't a public website.");
    expect(fake.messages()).toHaveLength(0);
  });
});
