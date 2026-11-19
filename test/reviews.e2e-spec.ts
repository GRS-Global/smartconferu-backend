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
    await as(admin.token)
      .post(`/admin/conferences/${conferenceId}/cfp/decision`, {
        approve: true,
      })
      .expect(204);

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

    it("gives the reviewer the conference's own review form and instructions, and the decision only once it was sent", async () => {
      const s = await assigned();
      // Standard form until the chair saves its own (kept in the chair-only settings).
      const standard = await as(s.reviewer.token)
        .get(`/assignments/${s.assignmentId}/review-form`)
        .expect(200);
      expect(standard.body).toEqual({
        form: null,
        instructions: { text: '', mode: 'html', pdf: null },
        decision: null,
      });
      await as(s.chair.token)
        .patch(`/conferences/${s.conferenceId}/settings`, {
          settings: {
            reviewForm: {
              sections: [{ id: 's1', title: 'Quality', fields: [] }],
            },
            reviewInstructions: {
              text: '<p>Be kind.</p>',
              mode: 'pdf',
              pdf: {
                path: 'conferences/x/instructions.pdf',
                name: 'How to review.pdf',
              },
            },
          },
        })
        .expect(200);
      const own = await as(s.reviewer.token)
        .get(`/assignments/${s.assignmentId}/review-form`)
        .expect(200);
      expect(own.body.form.sections).toHaveLength(1);
      expect(own.body.instructions).toEqual({
        text: '<p>Be kind.</p>',
        mode: 'pdf',
        pdf: {
          path: 'conferences/x/instructions.pdf',
          name: 'How to review.pdf',
        },
      });
      // The chair reads the same; the author and another reviewer do not.
      await as(s.chair.token)
        .get(`/assignments/${s.assignmentId}/review-form`)
        .expect(200);
      await as(s.author.token)
        .get(`/assignments/${s.assignmentId}/review-form`)
        .expect(404);
      await as(s.second.token)
        .get(`/assignments/${s.assignmentId}/review-form`)
        .expect(404);

      // A recorded decision stays hidden from the reviewer until it is sent to the authors.
      const types = await as(s.chair.token)
        .get(`/conferences/${s.conferenceId}/decision-types`)
        .expect(200);
      const accept = types.body.find(
        (d: { outcome: string }) => d.outcome === 'accept',
      );
      await as(s.chair.token)
        .post(`/submissions/${s.submissionId}/decision`, {
          decisionTypeId: accept.id,
        })
        .expect(200);
      const unsent = await as(s.reviewer.token)
        .get(`/assignments/${s.assignmentId}/review-form`)
        .expect(200);
      expect(unsent.body.decision).toBeNull();
      await as(s.chair.token)
        .post(`/submissions/${s.submissionId}/decision/notify`)
        .expect(200);
      const sent = await as(s.reviewer.token)
        .get(`/assignments/${s.assignmentId}/review-form`)
        .expect(200);
      expect(sent.body.decision).toEqual({
        outcome: 'accept',
        label: accept.label,
        color: accept.color,
      });
    });

    it('lets a reviewer ask for more time, a chair answers, and both are told', async () => {
      const s = await setup();
      // The chair gave this reviewer until 30 April 2099.
      const res = await as(s.chair.token)
        .post(`/submissions/${s.submissionId}/assignments`, {
          memberIds: [s.reviewerMember],
          dueDate: '2099-04-30',
        })
        .expect(200);
      const assignmentId = res.body.assignments[0].id as string;
      const ask = (token: string, body: object) =>
        as(token).post(`/assignments/${assignmentId}/extension-request`, body);

      // Nothing asked yet.
      const before = await as(s.reviewer.token)
        .get('/me/review-assignments')
        .expect(200);
      expect(before.body[0].extension).toBeNull();

      // The date must be after the current deadline, and not in the past.
      await ask(s.reviewer.token, { date: '2099-04-30' }).expect(422);
      await ask(s.reviewer.token, { date: '2001-01-01' }).expect(422);
      await ask(s.reviewer.token, { date: 'tomorrow' }).expect(400);
      // Only the assignment's own reviewer may ask.
      await ask(s.second.token, { date: '2099-05-10' }).expect(404);
      await ask(s.author.token, { date: '2099-05-10' }).expect(404);

      const asked = await ask(s.reviewer.token, {
        date: '2099-05-10',
        reason: 'Travelling for a week.',
      }).expect(200);
      expect(asked.body.extension).toMatchObject({
        date: '2099-05-10',
        reason: 'Travelling for a week.',
        status: 'pending',
        note: null,
        decidedAt: null,
      });
      expect(asked.body.dueAt).toMatch(/^2099-04-30/); // unchanged until a chair approves
      // One request may wait at a time.
      const again = await ask(s.reviewer.token, { date: '2099-05-12' }).expect(
        422,
      );
      expect(again.body.message).toMatch(/already have a request/);

      // The chair is told (bell and email) and sees the request on the review board.
      expect(await bell(s.chair.id)).toContain('extension_request');
      await t.sendQueuedEmails();
      expect(
        t
          .outbox()
          .some(
            (m) =>
              m.to === s.chair.email && /More time asked for/.test(m.subject),
          ),
      ).toBe(true);
      const board = await as(s.chair.token)
        .get(`/conferences/${s.conferenceId}/review-board`)
        .expect(200);
      const onBoard = board.body.papers
        .flatMap((p: { assignments: { id: string }[] }) => p.assignments)
        .find((a: { id: string }) => a.id === assignmentId);
      expect(onBoard.extension).toMatchObject({
        status: 'pending',
        date: '2099-05-10',
      });
      const extensionId = onBoard.extension.id as string;

      // Only a chair answers; the reviewer cannot approve their own request.
      const decide = (token: string, body: object) =>
        as(token).post(`/extension-requests/${extensionId}/decision`, body);
      await decide(s.reviewer.token, { approve: true }).expect(404);
      await decide(s.author.token, { approve: true }).expect(404);
      await as(s.chair.token)
        .post(
          '/extension-requests/00000000-0000-4000-8000-000000000000/decision',
          { approve: true },
        )
        .expect(404);

      // Declined: the deadline stays, the reviewer is told with the note, and may ask again.
      const declined = await decide(s.chair.token, {
        approve: false,
        note: 'The committee meets on 5 May.',
      }).expect(200);
      expect(declined.body.extension).toMatchObject({
        status: 'declined',
        note: 'The committee meets on 5 May.',
      });
      expect(declined.body.dueAt).toMatch(/^2099-04-30/);
      await decide(s.chair.token, { approve: true }).expect(422); // already answered
      expect(await bell(s.reviewer.id)).toContain('extension_decision');
      await t.sendQueuedEmails();
      expect(
        t
          .outbox()
          .some(
            (m) =>
              m.to === s.reviewer.email &&
              /More time for .* was not approved/.test(m.subject),
          ),
      ).toBe(true);

      // A second request, approved: the deadline moves to the date asked for.
      await ask(s.reviewer.token, { date: '2099-05-03' }).expect(200);
      const second = await as(s.reviewer.token)
        .get('/me/review-assignments')
        .expect(200);
      const secondId = second.body[0].extension.id as string;
      expect(second.body[0].extension.status).toBe('pending');
      const approved = await as(s.chair.token)
        .post(`/extension-requests/${secondId}/decision`, { approve: true })
        .expect(200);
      expect(approved.body.extension.status).toBe('approved');
      expect(approved.body.dueAt).toMatch(/^2099-05-03/);
      const mine = await as(s.reviewer.token)
        .get('/me/review-assignments')
        .expect(200);
      expect(mine.body[0].dueAt).toMatch(/^2099-05-03/);
      await t.sendQueuedEmails();
      expect(
        t
          .outbox()
          .some(
            (m) =>
              m.to === s.reviewer.email &&
              /New review deadline for/.test(m.subject),
          ),
      ).toBe(true);

      // The new deadline counts for the next request.
      await ask(s.reviewer.token, { date: '2099-05-03' }).expect(422);

      // Once the review is sent there is nothing left to move.
      await as(s.reviewer.token)
        .put(`/assignments/${assignmentId}/review`, { ...form, submit: true })
        .expect(200);
      await ask(s.reviewer.token, { date: '2099-06-01' }).expect(422);
    });

    it('lets a chair remind or write to a reviewer, who is told by bell and email', async () => {
      const s = await setup();
      const res = await as(s.chair.token)
        .post(`/submissions/${s.submissionId}/assignments`, {
          memberIds: [s.reviewerMember],
          dueDate: '2099-04-30',
        })
        .expect(200);
      const assignmentId = res.body.assignments[0].id as string;
      t.outbox().length = 0;

      await as(s.chair.token)
        .post(`/assignments/${assignmentId}/remind`, { note: 'Please hurry' })
        .expect(204);
      await as(s.chair.token)
        .post(`/assignments/${assignmentId}/message`, {
          message: 'Can you focus on the proofs?',
        })
        .expect(204);
      expect(await bell(s.reviewer.id)).toEqual(
        expect.arrayContaining(['review_reminder', 'reviewer_message']),
      );
      await t.sendQueuedEmails();
      const mails = t.outbox().filter((m) => m.to === s.reviewer.email);
      expect(mails.some((m) => /Reminder: your review of/.test(m.subject))).toBe(
        true,
      );
      expect(mails.some((m) => /Message about .* from the chair/.test(m.subject))).toBe(
        true,
      );
      const logged = await t.db.query<{ template_key: string }>(
        `select template_key from email_log where lower(to_email) = lower($1)
          and template_key in ('reviewReminderFromChair', 'reviewerMessage')`,
        [s.reviewer.email],
      );
      expect(logged.rows).toHaveLength(2);

      // An empty message, outsiders and authors are refused.
      await as(s.chair.token)
        .post(`/assignments/${assignmentId}/message`, { message: '  ' })
        .expect(400);
      await as(s.author.token)
        .post(`/assignments/${assignmentId}/remind`, {})
        .expect(404);
      await as(s.reviewer.token)
        .post(`/assignments/${assignmentId}/remind`, {})
        .expect(404);

      // Once the review is sent there is nothing left to remind.
      await as(s.reviewer.token)
        .put(`/assignments/${assignmentId}/review`, { ...form, submit: true })
        .expect(200);
      await as(s.chair.token)
        .post(`/assignments/${assignmentId}/remind`, {})
        .expect(422);
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
