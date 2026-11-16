import request from 'supertest';
import {
  createTestApp,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

describe('Peer review and decisions', () => {
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
    patch: (path: string, body: object) =>
      http()
        .patch(api(path))
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    delete: (path: string) =>
      http().delete(api(path)).set('Authorization', `Bearer ${token}`),
  });

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

  const emailsTo = async (email: string) =>
    (
      await t.db.query<{ template_key: string }>(
        `select template_key from email_log
          where lower(to_email) = lower($1) and event not like 'conference%'
            and event not like 'reviewer_invited' and event not like 'invitation%'
            and template_key not in ('submissionReceived', 'welcome', 'coAuthorAdded', 'newSubmissionAlert')
          order by created_at, template_key`,
        [email],
      )
    ).rows.map((r) => r.template_key);
  const bell = async (userId: string) =>
    (
      await t.db.query<{ kind: string }>(
        `select kind from notifications where user_id = $1
          and kind not in ('member_invited', 'invitation', 'new_submission', 'conference_decision', 'invitation_answer')
          order by created_at`,
        [userId],
      )
    ).rows.map((r) => r.kind);

  /** A conference with a paper under review, an active reviewer and an invited one. */
  async function setup() {
    const chair = await person({ firstName: 'Carla', lastName: 'Chair' });
    const author = await person({ firstName: 'Ada', lastName: 'Author' });
    const reviewer = await person({ firstName: 'Rae', lastName: 'Viewer' });
    const second = await person({ firstName: 'Sam', lastName: 'Second' });
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

    const paper = await as(author.token)
      .post(`/conferences/${conferenceId}/submissions`, {
        title: 'Graph networks for protein folding',
        abstract: 'We show that graph networks fold proteins.',
        authors: [
          { name: 'Ada Author', email: author.email, corresponding: true },
        ],
      })
      .expect(201);
    const submissionId = paper.body.id as string;
    // Through screening: under review.
    await t.db.query(
      `update submissions set outcome = 'plagiarism_clear' where id = $1`,
      [submissionId],
    );

    const invite = async (who: TestUser & { token: string }) => {
      const res = await as(chair.token)
        .post(`/conferences/${conferenceId}/members`, { email: who.email })
        .expect(201);
      return res.body.member.id as string;
    };
    const reviewerMember = await invite(reviewer);
    await as(reviewer.token)
      .post(`/invitations/${reviewerMember}/accept`)
      .expect(200);
    const secondMember = await invite(second);

    await t.sendQueuedEmails();
    t.outbox().length = 0;
    return {
      chair,
      author,
      reviewer,
      second,
      conferenceId,
      submissionId,
      reviewerMember,
      secondMember,
    };
  }

  const form = {
    score: 4,
    confidence: 'high',
    recommendation: 'accept',
    commentsToAuthor: 'Clear and convincing.',
    commentsToChair: 'Strong paper.',
    answers: { 'f-originality': 'high' },
  };

  describe('assigning', () => {
    it('gives the paper to active reviewers now and queues it for invited ones', async () => {
      const s = await setup();
      const res = await as(s.chair.token)
        .post(`/submissions/${s.submissionId}/assignments`, {
          memberIds: [s.reviewerMember, s.secondMember],
          dueDate: '2027-04-30',
        })
        .expect(200);
      expect(res.body.view).toBe('chair');
      expect(res.body.assignments).toHaveLength(1);
      expect(res.body.assignments[0]).toMatchObject({
        status: 'assigned',
        byChair: false,
        reviewer: { userId: s.reviewer.id, name: 'Rae Viewer' },
        dueAt: '2027-04-30T23:59:59.000Z',
        review: null,
      });
      expect(res.body.pending).toHaveLength(1);
      expect(res.body.pending[0]).toMatchObject({
        memberId: s.secondMember,
        name: 'Sam Second',
      });
      expect(await emailsTo(s.reviewer.email)).toEqual(['reviewAssignment']);
      expect(await bell(s.reviewer.id)).toEqual(['review_assigned']);

      // The invited reviewer gets the paper when they join the committee.
      await as(s.second.token)
        .post(`/invitations/${s.secondMember}/accept`)
        .expect(200);
      const after = await as(s.chair.token)
        .get(`/submissions/${s.submissionId}/reviews`)
        .expect(200);
      expect(after.body.pending).toHaveLength(0);
      expect(
        after.body.assignments.map(
          (a: { reviewer: { userId: string } }) => a.reviewer.userId,
        ),
      ).toEqual(expect.arrayContaining([s.reviewer.id, s.second.id]));
    });

    it('refuses authors, outsiders and non-chairs', async () => {
      const s = await setup();
      await as(s.reviewer.token)
        .post(`/submissions/${s.submissionId}/assignments`, {
          memberIds: [s.reviewerMember],
        })
        .expect(404);
      await as(s.chair.token)
        .post(`/submissions/${s.submissionId}/assignments`, {
          memberIds: ['00000000-0000-4000-8000-000000000000'],
        })
        .expect(400);

      // An author can't review their own paper.
      const authorMember = await as(s.chair.token)
        .post(`/conferences/${s.conferenceId}/members`, {
          email: s.author.email,
        })
        .expect(201);
      await as(s.author.token)
        .post(`/invitations/${authorMember.body.member.id}/accept`)
        .expect(200);
      const res = await as(s.chair.token)
        .post(`/submissions/${s.submissionId}/assignments`, {
          memberIds: [authorMember.body.member.id],
        })
        .expect(422);
      expect(res.body.message).toMatch(/author of this paper/);
    });

    it('takes a paper back from a reviewer, who is told', async () => {
      const s = await setup();
      const res = await as(s.chair.token)
        .post(`/submissions/${s.submissionId}/assignments`, {
          memberIds: [s.reviewerMember],
        })
        .expect(200);
      const assignmentId = res.body.assignments[0].id as string;
      const removed = await as(s.chair.token)
        .delete(`/assignments/${assignmentId}`)
        .expect(200);
      expect(removed.body.assignments[0].status).toBe('removed');
      expect(removed.body.summary).toMatchObject({ assigned: 0 });
      expect(await emailsTo(s.reviewer.email)).toEqual([
        'reviewAssignment',
        'assignmentRemoved',
      ]);
      // The reviewer no longer sees the paper.
      await as(s.reviewer.token)
        .get(`/assignments/${assignmentId}`)
        .expect(404);
      // Given again: back to assigned.
      const again = await as(s.chair.token)
        .post(`/submissions/${s.submissionId}/assignments`, {
          memberIds: [s.reviewerMember],
        })
        .expect(200);
      expect(again.body.assignments[0]).toMatchObject({
        id: assignmentId,
        status: 'assigned',
      });
    });
  });

  describe('reviewing', () => {
    async function assigned() {
      const s = await setup();
      const res = await as(s.chair.token)
        .post(`/submissions/${s.submissionId}/assignments`, {
          memberIds: [s.reviewerMember],
        })
        .expect(200);
      return { ...s, assignmentId: res.body.assignments[0].id as string };
    }

    it('lets the reviewer decline with a reason, and tells the chairs', async () => {
      const s = await assigned();
      const res = await as(s.reviewer.token)
        .post(`/assignments/${s.assignmentId}/respond`, {
          accept: false,
          reason: 'Conflict of interest',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'declined',
        declineReason: 'Conflict of interest',
        can: { respond: false, review: false },
      });
      expect(await bell(s.chair.id)).toEqual(['assignment_declined']);
      await as(s.reviewer.token)
        .post(`/assignments/${s.assignmentId}/respond`, { accept: true })
        .expect(404);
    });

    it('saves drafts, sends the review once with its emails, and allows corrections until the decision', async () => {
      const s = await assigned();
      await as(s.reviewer.token)
        .post(`/assignments/${s.assignmentId}/respond`, { accept: true })
        .expect(200);

      const queue = await as(s.reviewer.token)
        .get('/me/review-assignments')
        .expect(200);
      expect(queue.body).toHaveLength(1);
      expect(queue.body[0]).toMatchObject({
        id: s.assignmentId,
        status: 'accepted',
        can: { respond: false, review: true },
        paper: {
          paperId: 'ICX-1',
          title: 'Graph networks for protein folding',
        },
      });

      const draft = await as(s.reviewer.token)
        .put(`/assignments/${s.assignmentId}/review`, {
          ...form,
          submit: false,
        })
        .expect(200);
      expect(draft.body).toMatchObject({
        firstSubmit: false,
        status: 'accepted',
        review: { status: 'draft', score: 4 },
      });
      expect(await emailsTo(s.reviewer.email)).toEqual(['reviewAssignment']);

      const sent = await as(s.reviewer.token)
        .put(`/assignments/${s.assignmentId}/review`, { ...form, submit: true })
        .expect(200);
      expect(sent.body).toMatchObject({
        firstSubmit: true,
        status: 'submitted',
        review: { status: 'submitted', commentsToChair: 'Strong paper.' },
      });
      expect(await emailsTo(s.reviewer.email)).toEqual([
        'reviewAssignment',
        'reviewThanks',
      ]);
      expect(await emailsTo(s.chair.email)).toEqual([
        'chairDecisionReady',
        'reviewSubmittedChair',
      ]);
      expect(await bell(s.chair.id)).toEqual(['review_submitted']);

      // A draft never takes a sent review back; a correction is sent again without new emails.
      const ignored = await as(s.reviewer.token)
        .put(`/assignments/${s.assignmentId}/review`, {
          score: 1,
          submit: false,
        })
        .expect(200);
      expect(ignored.body.review).toMatchObject({
        status: 'submitted',
        score: 4,
      });
      await as(s.reviewer.token)
        .put(`/assignments/${s.assignmentId}/review`, {
          ...form,
          score: 5,
          submit: true,
        })
        .expect(200)
        .expect((r) => expect(r.body.firstSubmit).toBe(false));
      expect(await emailsTo(s.reviewer.email)).toHaveLength(2);

      // After a decision the review is locked.
      await t.db.query(
        `update submissions set outcome = 'accept' where id = $1`,
        [s.submissionId],
      );
      const locked = await as(s.reviewer.token)
        .put(`/assignments/${s.assignmentId}/review`, { ...form, submit: true })
        .expect(422);
      expect(locked.body.message).toMatch(/already has a decision/);
    });

    it('keeps reviews from authors and other reviewers', async () => {
      const s = await assigned();
      await as(s.author.token)
        .get(`/assignments/${s.assignmentId}`)
        .expect(404);
      await as(s.author.token)
        .put(`/assignments/${s.assignmentId}/review`, { ...form, submit: true })
        .expect(404);
      const authorView = await as(s.author.token)
        .get(`/submissions/${s.submissionId}/reviews`)
        .expect(200);
      expect(authorView.body).toMatchObject({
        view: 'author',
        assignments: [],
        authorReviews: [],
      });
      const reviewerView = await as(s.reviewer.token)
        .get(`/submissions/${s.submissionId}/reviews`)
        .expect(200);
      expect(reviewerView.body.view).toBe('reviewer');
      expect(reviewerView.body.assignments).toHaveLength(1);
    });
  });

  describe('chairs and reviews', () => {
    async function reviewed() {
      const s = await setup();
      const res = await as(s.chair.token)
        .post(`/submissions/${s.submissionId}/assignments`, {
          memberIds: [s.reviewerMember],
        })
        .expect(200);
      const assignmentId = res.body.assignments[0].id as string;
      const sent = await as(s.reviewer.token)
        .put(`/assignments/${assignmentId}/review`, { ...form, submit: true })
        .expect(200);
      return { ...s, assignmentId, reviewId: sent.body.review.id as string };
    }

    it('edits a sent review and tells the reviewer', async () => {
      const s = await reviewed();
      const res = await as(s.chair.token)
        .put(`/reviews/${s.reviewId}`, { ...form, score: 3 })
        .expect(200);
      expect(res.body.review).toMatchObject({ score: 3 });
      expect(res.body.review.editedByChairAt).not.toBeNull();
      expect(await bell(s.reviewer.id)).toEqual([
        'review_assigned',
        'review_edited',
      ]);
      expect(await emailsTo(s.reviewer.email)).toContain('reviewEditedByChair');
      await as(s.reviewer.token)
        .put(`/reviews/${s.reviewId}`, form)
        .expect(403);
    });

    it("writes the chair's own review, which counts", async () => {
      const s = await reviewed();
      const res = await as(s.chair.token)
        .put(`/submissions/${s.submissionId}/chair-review`, {
          ...form,
          score: 2,
        })
        .expect(200);
      expect(res.body).toMatchObject({
        byChair: true,
        status: 'submitted',
        review: { status: 'submitted', score: 2 },
      });
      const all = await as(s.chair.token)
        .get(`/submissions/${s.submissionId}/reviews`)
        .expect(200);
      expect(all.body.summary).toEqual({
        assigned: 2,
        submitted: 2,
        averageScore: 3,
        complete: true,
      });
    });

    it('sends the decision with the shared reviews, and "Decision changed" after a change', async () => {
      const s = await reviewed();
      // Nothing to send before a decision.
      await as(s.chair.token)
        .post(`/submissions/${s.submissionId}/decision/notify`)
        .expect(422);

      const types = await as(s.chair.token)
        .get(`/conferences/${s.conferenceId}/decision-types`)
        .expect(200);
      const accept = types.body.find(
        (d: { outcome: string }) => d.outcome === 'accept',
      );
      const reject = types.body.find(
        (d: { outcome: string }) => d.outcome === 'reject',
      );
      await as(s.chair.token)
        .post(`/submissions/${s.submissionId}/decision`, {
          decisionTypeId: accept.id,
        })
        .expect(200);
      // Authors don't see a decision until it is sent.
      const before = await as(s.author.token)
        .get(`/submissions/${s.submissionId}`)
        .expect(200);
      expect(before.body.outcome).toBe('no_decision');

      const sent = await as(s.chair.token)
        .post(`/submissions/${s.submissionId}/decision/notify`, {
          note: 'Well done.',
          shareReviewIds: [s.reviewId],
        })
        .expect(200);
      expect(sent.body).toMatchObject({
        changed: false,
        submission: { notifiedOutcome: 'accept', decisionNote: 'Well done.' },
      });
      expect(sent.body.queued).toBe(2);
      expect(await emailsTo(s.author.email)).toEqual(['acceptance']);
      expect(await emailsTo(s.reviewer.email)).toContain(
        'finalDecisionReviewers',
      );
      expect(await bell(s.author.id)).toEqual(['decision']);

      const authorView = await as(s.author.token)
        .get(`/submissions/${s.submissionId}/reviews`)
        .expect(200);
      expect(authorView.body.authorReviews).toEqual([
        {
          reviewerNo: 1,
          score: 4,
          recommendation: 'accept',
          commentsToAuthor: 'Clear and convincing.',
          submittedAt: expect.any(String),
        },
      ]);
      await t.sendQueuedEmails();
      const acceptance = t.outbox().find((m) => m.to === s.author.email);
      expect(acceptance?.text).toContain('Clear and convincing.');
      expect(acceptance?.text).not.toContain('Strong paper.');

      await as(s.chair.token)
        .post(`/submissions/${s.submissionId}/decision`, {
          decisionTypeId: reject.id,
        })
        .expect(200);
      const changed = await as(s.chair.token)
        .post(`/submissions/${s.submissionId}/decision/notify`)
        .expect(200);
      expect(changed.body.changed).toBe(true);
      expect(await emailsTo(s.author.email)).toEqual([
        'acceptance',
        'decisionChanged',
      ]);
    });

    it('shares and hides a review', async () => {
      const s = await reviewed();
      await as(s.chair.token)
        .patch(`/reviews/${s.reviewId}/shared`, { shared: true })
        .expect(200)
        .expect((r) => expect(r.body.sharedWithAuthor).toBe(true));
      await as(s.reviewer.token)
        .patch(`/reviews/${s.reviewId}/shared`, { shared: false })
        .expect(403);
    });
  });

  describe('decision types', () => {
    it('replaces the list, but keeps types a paper uses', async () => {
      const s = await setup();
      const types = await as(s.chair.token)
        .get(`/conferences/${s.conferenceId}/decision-types`)
        .expect(200);
      const used = types.body.find(
        (d: { outcome: string }) => d.outcome === 'plagiarism_clear',
      );
      await t.db.query(
        'update submissions set decision_type_id = $2 where id = $1',
        [s.submissionId, used.id],
      );
      const others = types.body.filter((d: { id: string }) => d.id !== used.id);
      const refused = await as(s.chair.token)
        .put(`/conferences/${s.conferenceId}/decision-types`, {
          types: others.map(
            ({
              id,
              label,
              outcome,
            }: {
              id: string;
              label: string;
              outcome: string;
            }) => ({ id, label, outcome }),
          ),
        })
        .expect(422);
      expect(refused.body.message).toMatch(/used by 1 paper/);

      const res = await as(s.chair.token)
        .put(`/conferences/${s.conferenceId}/decision-types`, {
          types: [
            { id: used.id, label: 'Cleared', outcome: 'plagiarism_clear' },
            { label: 'Strong accept', outcome: 'accept', color: '#16A34A' },
          ],
        })
        .expect(200);
      expect(
        res.body.map((d: { label: string; position: number }) => [
          d.label,
          d.position,
        ]),
      ).toEqual([
        ['Cleared', 0],
        ['Strong accept', 1],
      ]);
      await as(s.reviewer.token)
        .put(`/conferences/${s.conferenceId}/decision-types`, {
          types: [{ label: 'X', outcome: 'accept' }],
        })
        .expect(403);
    });
  });
});
