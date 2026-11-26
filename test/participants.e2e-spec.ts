import request from 'supertest';
import {
  createTestApp,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

interface Participant {
  id: string;
  category: string;
  submissionId: string | null;
  paperId: string | null;
  paperStatus: string | null;
  onAuthorList: boolean | null;
  name: string;
  email: string;
  payment: string;
  amount: number | null;
  currency: string | null;
  receipt: { fileName: string } | null;
  note: string | null;
}

interface ImportRow {
  row: number;
  status: string;
  key: string;
  changes: Array<{ field: string; from: string | null; to: string | null }>;
  errors: string[];
  warnings: string[];
}

interface Activity {
  module: string;
  action: string;
  description: string;
  previousValue: string | null;
  newValue: string | null;
}

const PDF = Buffer.from('%PDF-1.7\n%%EOF\n');

describe('Registration links, receipts, participants and import', () => {
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

  const as = (token: string) => {
    const auth = { Authorization: `Bearer ${token}` };
    return {
      get: (path: string) => http().get(api(path)).set(auth),
      post: (path: string, body?: object) =>
        http()
          .post(api(path))
          .set(auth)
          .send(body ?? {}),
      put: (path: string, body: object) =>
        http().put(api(path)).set(auth).send(body),
      patch: (path: string, body: object) =>
        http().patch(api(path)).set(auth).send(body),
      delete: (path: string) => http().delete(api(path)).set(auth),
      upload: (path: string, data: Buffer, name: string) =>
        http().post(api(path)).set(auth).attach('file', data, name),
    };
  };

  /** A live conference in EUR with a registration link, and three papers by `author`. */
  async function setup({ currency = 'EUR' as string | null } = {}) {
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
    await as(chair.token)
      .patch(`/conferences/${conferenceId}`, {
        currency,
        registrationUrl: 'https://icx.example.org/register',
      })
      .expect(200);
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
            authors: [
              { name: 'Ada Author', email: author.email, corresponding: true },
              { name: 'Ben Second', email: 'Ben.Second@uni.example' },
            ],
          })
          .expect(201)
      ).body.id as string;
    const first = await submit('Graph networks for protein folding'); // ICX-1
    const second = await submit('A second paper'); // ICX-2
    const pending = await submit('Still under review'); // ICX-3
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
    await decide(first, 'accept');
    await decide(second, 'accept');
    const activity = async (module?: string) => {
      const log = await as(chair.token)
        .get(`/conferences/${conferenceId}/activity`)
        .expect(200);
      return (log.body as Activity[]).filter(
        (e) => !module || e.module === module,
      );
    };
    return {
      chair,
      author,
      outsider,
      conferenceId,
      first,
      second,
      pending,
      decide,
      activity,
    };
  }

  const paid = {
    payment: 'paid',
    amount: 250,
    method: 'card',
    paidOn: '2026-11-20',
    transactionRef: 'TX-1',
    payerName: 'Ada Author',
    attendance: 'physical',
    presenterEmail: null,
    note: null,
  };

  const participant = (over: object = {}) => ({
    category: 'standard',
    submissionId: null,
    name: 'Dana Delegate',
    email: 'dana@delegates.example',
    affiliation: 'Uni of Delegates',
    country: 'India',
    attendance: 'virtual',
    payment: 'paid',
    amount: 100,
    method: 'online',
    paidOn: '2026-11-21',
    transactionRef: 'UPI-77',
    payerName: null,
    note: 'Early bird',
    ...over,
  });

  describe('conference settings', () => {
    it('checks the links, reads the currency code, and locks it once amounts are recorded', async () => {
      const s = await setup({ currency: null });
      const path = `/conferences/${s.conferenceId}`;

      const badLink = await as(s.chair.token)
        .patch(path, { registrationUrl: 'register here' })
        .expect(400);
      expect(JSON.stringify(badLink.body.details)).toMatch(
        /full registration link/,
      );
      await as(s.chair.token)
        .patch(path, { participantRegistrationUrl: 'ftp://x.example.org' })
        .expect(400);
      await as(s.chair.token).patch(path, { currency: 'EURO' }).expect(400);

      // No currency yet: a paid amount can't be recorded.
      const noCurrency = await as(s.chair.token)
        .put(`/submissions/${s.first}/registration`, paid)
        .expect(400);
      expect(noCurrency.body.message).toMatch(/Set the conference currency/);

      const saved = await as(s.chair.token)
        .patch(path, {
          currency: ' inr ',
          participantRegistrationUrl: 'https://icx.example.org/delegates',
          registrationDeadline: '2027-03-01',
        })
        .expect(200);
      expect(saved.body).toMatchObject({
        currency: 'INR',
        registrationUrl: 'https://icx.example.org/register',
        participantRegistrationUrl: 'https://icx.example.org/delegates',
        registrationDeadline: '2027-03-01',
      });
      // Still free to change while nothing is recorded.
      await as(s.chair.token).patch(path, { currency: 'USD' }).expect(200);

      await as(s.chair.token)
        .put(`/submissions/${s.first}/registration`, paid)
        .expect(200);
      const locked = await as(s.chair.token)
        .patch(path, { currency: 'EUR' })
        .expect(422);
      expect(locked.body.message).toBe(
        "Payments are already recorded in USD, so the currency can't be changed.",
      );
      // Sending the same currency again is fine.
      await as(s.chair.token).patch(path, { currency: 'usd' }).expect(200);
    });
  });

  describe('paper receipts', () => {
    it('lets a chair attach, replace and remove the receipt of a paid fee, and the author download it', async () => {
      const s = await setup();
      const receipt = `/submissions/${s.first}/registration/receipt`;

      const unpaid = await as(s.chair.token)
        .upload(receipt, PDF, 'receipt.pdf')
        .expect(422);
      expect(unpaid.body.message).toMatch(/Record the fee as Paid/);

      await as(s.chair.token)
        .put(`/submissions/${s.first}/registration`, paid)
        .expect(200);
      await as(s.chair.token)
        .upload(receipt, Buffer.from('<html>'), 'receipt.pdf')
        .expect(400);
      await as(s.author.token).upload(receipt, PDF, 'receipt.pdf').expect(403);

      const uploaded = await as(s.chair.token)
        .upload(receipt, PDF, 'receipt.pdf')
        .expect(200);
      expect(uploaded.body.registration.receipt).toEqual({
        fileName: 'receipt.pdf',
        sizeBytes: PDF.length,
        uploadedAt: expect.any(String),
      });
      await as(s.chair.token)
        .upload(receipt, PDF, 'receipt-v2.pdf')
        .expect(200);

      // The author downloads it once told the paper is accepted.
      await as(s.author.token).get(receipt).expect(404);
      await as(s.chair.token)
        .post(`/submissions/${s.first}/decision/notify`)
        .expect(200);
      const download = await as(s.author.token).get(receipt).expect(200);
      expect(download.headers['content-type']).toMatch(/application\/pdf/);
      expect(download.headers['content-disposition']).toContain(
        'receipt-v2.pdf',
      );
      await as(s.outsider.token).get(receipt).expect(404);

      await as(s.chair.token).delete(receipt).expect(200);
      await as(s.chair.token).delete(receipt).expect(404);
      await as(s.chair.token)
        .upload(receipt, PDF, 'receipt-v3.pdf')
        .expect(200);

      // The fee no longer paid: the receipt goes with it.
      const waived = await as(s.chair.token)
        .put(`/submissions/${s.first}/registration`, {
          payment: 'waived',
          attendance: 'physical',
          presenterEmail: null,
          note: null,
        })
        .expect(200);
      expect(waived.body.registration.receipt).toBeNull();

      const log = await s.activity('Registration');
      expect(log.map((e) => e.description)).toEqual(
        expect.arrayContaining([
          'Uploaded the payment receipt of ICX-1.',
          'Replaced the payment receipt of ICX-1.',
          'Removed the payment receipt of ICX-1.',
        ]),
      );
    });
  });

  describe('participants', () => {
    it('lets a chair add, change, list and remove participants, each email once', async () => {
      const s = await setup();
      const base = `/conferences/${s.conferenceId}/participants`;

      const added = await as(s.chair.token)
        .post(base, participant())
        .expect(201);
      expect(added.body).toMatchObject({
        category: 'standard',
        submissionId: null,
        paperId: null,
        name: 'Dana Delegate',
        email: 'dana@delegates.example',
        payment: 'paid',
        amount: 100,
        currency: 'EUR',
        method: 'online',
        note: 'Early bird',
      });
      const id = added.body.id as string;

      const twice = await as(s.chair.token)
        .post(base, participant({ email: 'DANA@delegates.example' }))
        .expect(409);
      expect(twice.body.message).toMatch(/already registered as a participant/);

      // The payment rules are the same as for papers.
      await as(s.chair.token)
        .post(base, participant({ email: 'e@x.example', amount: null }))
        .expect(400);
      await as(s.chair.token)
        .post(
          base,
          participant({ email: 'e@x.example', submissionId: s.first }),
        )
        .expect(400);

      const changed = await as(s.chair.token)
        .put(
          `${base}/${id}`,
          participant({
            category: 'student',
            payment: 'not_paid',
            amount: null,
            method: null,
            paidOn: null,
            transactionRef: null,
          }),
        )
        .expect(200);
      expect(changed.body).toMatchObject({
        category: 'student',
        payment: 'not_paid',
        amount: null,
      });

      // Chairs only.
      await as(s.author.token).get(base).expect(403);
      await as(s.outsider.token).get(base).expect(404);
      await as(s.author.token).post(base, participant()).expect(403);

      const list = await as(s.chair.token).get(base).expect(200);
      expect((list.body as Participant[]).map((p) => p.email)).toEqual([
        'dana@delegates.example',
      ]);

      await as(s.chair.token).delete(`${base}/${id}`).expect(204);
      await as(s.chair.token).delete(`${base}/${id}`).expect(404);

      const log = await s.activity('Participants');
      expect(log.map((e) => e.description)).toEqual([
        'Removed participant Dana Delegate (dana@delegates.example).',
        'Updated participant Dana Delegate (dana@delegates.example).',
        'Added participant Dana Delegate (dana@delegates.example).',
      ]);
      expect(log[2].newValue).toBe(
        'Standard · Paid 100.00 EUR by Online · Virtual',
      );
      expect(log[1]).toMatchObject({
        previousValue: 'Standard · Paid 100.00 EUR by Online · Virtual',
        newValue: 'Student · Not paid · Virtual',
      });
    });

    it('links a co-author to an accepted paper, shown on that paper', async () => {
      const s = await setup();
      const base = `/conferences/${s.conferenceId}/participants`;
      const coAuthor = (over: object = {}) =>
        participant({
          category: 'co_author',
          submissionId: s.first,
          name: 'Ben Second',
          email: 'ben.second@uni.example',
          ...over,
        });

      await as(s.chair.token)
        .post(base, coAuthor({ submissionId: null }))
        .expect(400);
      const notAccepted = await as(s.chair.token)
        .post(base, coAuthor({ submissionId: s.pending }))
        .expect(422);
      expect(notAccepted.body.message).toBe(
        'Co-authors can register for accepted papers only.',
      );

      const added = await as(s.chair.token).post(base, coAuthor()).expect(201);
      expect(added.body).toMatchObject({
        paperId: 'ICX-1',
        paperStatus: 'accepted',
        onAuthorList: true,
      });
      // The same person may register again for another paper, not twice for one.
      await as(s.chair.token).post(base, coAuthor()).expect(409);
      await as(s.chair.token)
        .post(base, coAuthor({ submissionId: s.second }))
        .expect(201);
      // Someone not on the author list can be added, flagged for a check.
      const stranger = await as(s.chair.token)
        .post(base, coAuthor({ name: 'Cy', email: 'cy@else.example' }))
        .expect(201);
      expect(stranger.body.onAuthorList).toBe(false);

      const paper = await as(s.chair.token)
        .get(`/submissions/${s.first}`)
        .expect(200);
      expect(
        (paper.body.participants as Array<{ email: string }>)
          .map((p) => p.email)
          .sort(),
      ).toEqual(['ben.second@uni.example', 'cy@else.example']);

      // A participant's receipt works like a paper's.
      const receipt = `${base}/${added.body.id}/receipt`;
      const withReceipt = await as(s.chair.token)
        .upload(receipt, PDF, 'ben.pdf')
        .expect(200);
      expect(withReceipt.body.receipt.fileName).toBe('ben.pdf');
      await as(s.chair.token).get(receipt).expect(200);
      await as(s.chair.token).delete(receipt).expect(200);
    });
  });

  describe('import', () => {
    const importAs = (
      token: string,
      conferenceId: string,
      kind: string,
      rows: object[],
      apply: boolean,
    ) =>
      as(token).post(`/conferences/${conferenceId}/registrations/import`, {
        kind,
        rows,
        apply,
      });

    it('checks paper payments first, then saves all rows or none', async () => {
      const s = await setup();
      const rows = [
        {
          row: 2,
          paperId: 'ICX-1',
          payment: 'Paid',
          amount: '₹ 2,500',
          method: 'UPI',
          paidOn: '20/11/2026',
          transactionRef: 'UPI-1',
        },
        { row: 3, paperId: '2', payment: 'Waived' },
        { row: 4, paperId: 'ICX-3', payment: 'Paid', amount: '10' },
        { row: 5, paperId: 'ICX-99', payment: 'Paid', amount: '10' },
        { row: 6, paperId: 'ICX-1', payment: 'Not paid' },
        {
          row: 7,
          paperId: 'ICX-2',
          payment: 'Paid',
          amount: '1.250,00',
          paidOn: '31/02/2026',
        },
      ];

      const preview = await importAs(
        s.chair.token,
        s.conferenceId,
        'papers',
        rows,
        false,
      ).expect(200);
      expect(preview.body).toMatchObject({
        kind: 'papers',
        applied: false,
        // No payment recorded yet for either paper: both rows are new.
        counts: { new: 2, update: 0, unchanged: 0, error: 4 },
      });
      const byRow = Object.fromEntries(
        (preview.body.rows as ImportRow[]).map((r) => [r.row, r]),
      );
      expect(byRow[2]).toMatchObject({ status: 'new', key: 'ICX-1' });
      expect(byRow[2].changes).toEqual(
        expect.arrayContaining([
          { field: 'payment', from: 'not_paid', to: 'paid' },
          { field: 'amount', from: null, to: '2500' },
          { field: 'method', from: null, to: 'online' },
          { field: 'paidOn', from: null, to: '2026-11-20' },
        ]),
      );
      expect(byRow[4].errors).toEqual(['ICX-3 is not accepted.']);
      expect(byRow[5].errors).toEqual(['There is no paper ICX-99.']);
      expect(byRow[6].errors).toEqual(['ICX-1 is already in row 2.']);
      expect(byRow[7].errors).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/Amount "1.250,00" isn't a number/),
          expect.stringMatching(/Payment date "31\/02\/2026" isn't a date/),
        ]),
      );

      // Errors: nothing is saved.
      const refused = await importAs(
        s.chair.token,
        s.conferenceId,
        'papers',
        rows,
        true,
      ).expect(200);
      expect(refused.body.applied).toBe(false);
      const untouched = await as(s.chair.token)
        .get(`/submissions/${s.first}`)
        .expect(200);
      expect(untouched.body.registration.payment).toBe('not_paid');

      // The good rows alone go in.
      const saved = await importAs(
        s.chair.token,
        s.conferenceId,
        'papers',
        rows.slice(0, 2),
        true,
      ).expect(200);
      expect(saved.body).toMatchObject({
        applied: true,
        counts: { new: 2, update: 0, unchanged: 0, error: 0 },
      });
      const first = await as(s.chair.token)
        .get(`/submissions/${s.first}`)
        .expect(200);
      expect(first.body.registration).toMatchObject({
        payment: 'paid',
        amount: 2500,
        currency: 'EUR',
        method: 'online',
        paidOn: '2026-11-20',
        transactionRef: 'UPI-1',
      });

      // The same sheet again changes nothing.
      const again = await importAs(
        s.chair.token,
        s.conferenceId,
        'papers',
        rows.slice(0, 2),
        false,
      ).expect(200);
      expect(again.body.counts).toMatchObject({ unchanged: 2, update: 0 });

      // Chairs only.
      await importAs(
        s.author.token,
        s.conferenceId,
        'papers',
        rows,
        false,
      ).expect(403);

      const log = await s.activity();
      expect(log[0]).toMatchObject({
        module: 'Registration',
        action: 'Imported',
        description: 'Imported paper payments: 2 new, 0 updated, 0 unchanged.',
      });
      expect(
        log.filter(
          (e) =>
            e.description ===
            'Recorded payment and attendance for ICX-1 (import).',
        ),
      ).toHaveLength(1);
    });

    it('adds and updates participants matched by email, and warns about a co-author not on the paper', async () => {
      const s = await setup();
      await as(s.chair.token)
        .post(
          `/conferences/${s.conferenceId}/participants`,
          participant({
            payment: 'not_paid',
            amount: null,
            method: null,
            paidOn: null,
            transactionRef: null,
          }),
        )
        .expect(201);
      const rows = [
        {
          row: 2,
          category: 'Standard',
          name: 'Dana Delegate',
          email: 'Dana@Delegates.example',
          payment: 'Paid',
          amount: '100',
          method: 'Card',
          attendance: 'Digital',
        },
        {
          row: 3,
          category: 'Co-author',
          paperId: 'ICX-1',
          name: 'Cy Else',
          email: 'cy@else.example',
          payment: 'Not paid',
          attendance: 'In person',
        },
        {
          row: 4,
          category: 'Student',
          name: 'Stu Dent',
          email: 'stu@uni.example',
          payment: 'Free',
        },
        {
          row: 5,
          category: 'VIP',
          name: 'X',
          email: 'not-an-email',
          payment: 'Paid',
        },
      ];

      const preview = await importAs(
        s.chair.token,
        s.conferenceId,
        'participants',
        rows,
        false,
      ).expect(200);
      expect(preview.body.counts).toEqual({
        new: 2,
        update: 1,
        unchanged: 0,
        error: 1,
      });
      const byRow = Object.fromEntries(
        (preview.body.rows as ImportRow[]).map((r) => [r.row, r]),
      );
      expect(byRow[2].status).toBe('update');
      expect(byRow[3].warnings).toEqual([
        'cy@else.example is not on the author list of ICX-1.',
      ]);
      expect(byRow[5].errors.length).toBeGreaterThanOrEqual(2);

      const saved = await importAs(
        s.chair.token,
        s.conferenceId,
        'participants',
        rows.slice(0, 3),
        true,
      ).expect(200);
      expect(saved.body.applied).toBe(true);

      const list = await as(s.chair.token)
        .get(`/conferences/${s.conferenceId}/participants`)
        .expect(200);
      const byEmail = Object.fromEntries(
        (list.body as Participant[]).map((p) => [p.email.toLowerCase(), p]),
      );
      expect(Object.keys(byEmail).sort()).toEqual([
        'cy@else.example',
        'dana@delegates.example',
        'stu@uni.example',
      ]);
      expect(byEmail['dana@delegates.example']).toMatchObject({
        payment: 'paid',
        amount: 100,
        note: 'Early bird', // a column left out keeps its value
      });
      expect(byEmail['cy@else.example']).toMatchObject({
        category: 'co_author',
        paperId: 'ICX-1',
        onAuthorList: false,
      });
      expect(byEmail['stu@uni.example']).toMatchObject({
        category: 'student',
        payment: 'waived',
      });

      const log = await s.activity('Participants');
      expect(log[0].description).toBe(
        'Imported participants: 2 new, 1 updated, 0 unchanged.',
      );
    });
  });
});
