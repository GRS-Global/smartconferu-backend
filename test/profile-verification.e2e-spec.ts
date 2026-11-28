import request from 'supertest';
import { createTestApp, type TestApp } from './support/test-app.js';

describe('Verify my profile', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  afterEach(() => t.reset());

  const http = () => request(t.app.getHttpServer());
  const api = (p: string) => `/api/v1${p}`;

  const EVIDENCE = {
    googleScholarUrl: 'https://scholar.google.com/citations?user=x',
    linkedinUrl: 'https://www.linkedin.com/in/mia',
    timeline: [
      {
        id: 'm1',
        type: 'membership',
        title: 'Member',
        org: 'IEEE',
        current: true,
        societyId: 'ieee',
      },
    ],
  };

  async function member(email = 'mia@example.org', complete = true) {
    const user = await t.createUser({ email, firstName: 'Mia' });
    if (complete) {
      await t.db.query(
        `update profiles set designation = 'Professor', affiliation = 'IIT Bombay', country = 'India' where id = $1`,
        [user.id],
      );
      // Something to verify against: two profile links and a membership.
      await t.db.query(
        `update profile_details set data = $2::jsonb where user_id = $1`,
        [user.id, JSON.stringify(EVIDENCE)],
      );
    }
    return { ...user, token: await t.tokenFor(user.id) };
  }

  async function admin() {
    const user = await t.createUser({ firstName: 'Root' });
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
    get: (p: string) =>
      http().get(api(p)).set('Authorization', `Bearer ${token}`),
    post: (p: string, body: object = {}) =>
      http().post(api(p)).set('Authorization', `Bearer ${token}`).send(body),
    del: (p: string) =>
      http().delete(api(p)).set('Authorization', `Bearer ${token}`),
  });

  it('starts as "none"', async () => {
    const mia = await member();
    const res = await as(mia.token).get('/me/profile-verification').expect(200);
    expect(res.body.status).toBe('none');
  });

  it('needs a filled-in profile first', async () => {
    const mia = await member('mia@example.org', false);
    await as(mia.token).post('/me/profile-verification').expect(422);
  });

  it('needs at least two profile links and one membership', async () => {
    const mia = await member();
    const set = (data: object, orcid: string | null = null) =>
      Promise.all([
        t.db.query(
          'update profile_details set data = $2::jsonb where user_id = $1',
          [mia.id, JSON.stringify(data)],
        ),
        t.db.query('update profiles set orcid_id = $2 where id = $1', [
          mia.id,
          orcid,
        ]),
      ]);
    // One link only.
    await set({
      linkedinUrl: 'https://linkedin.com/in/mia',
      timeline: EVIDENCE.timeline,
    });
    const one = await as(mia.token)
      .post('/me/profile-verification')
      .expect(422);
    expect(one.body.message).toMatch(/at least 2 profile links .*you have 1/);
    // Two links (ORCID counts), no membership.
    await set(
      { linkedinUrl: 'https://linkedin.com/in/mia' },
      '0000-0002-1825-0097',
    );
    const noMem = await as(mia.token)
      .post('/me/profile-verification')
      .expect(422);
    expect(noMem.body.message).toMatch(/at least 1 membership/);
    // A membership a Super Admin refused does not count.
    await set(
      {
        linkedinUrl: 'https://linkedin.com/in/mia',
        timeline: [{ ...EVIDENCE.timeline[0], verification: 'rejected' }],
      },
      '0000-0002-1825-0097',
    );
    await as(mia.token).post('/me/profile-verification').expect(422);
    // Two links (ORCID + LinkedIn) and a membership: accepted.
    await set(
      {
        linkedinUrl: 'https://linkedin.com/in/mia',
        timeline: EVIDENCE.timeline,
      },
      '0000-0002-1825-0097',
    );
    await as(mia.token).post('/me/profile-verification').expect(200);
  });

  it('files one request, tells the Super Admin, and cannot be filed twice', async () => {
    const root = await admin();
    const mia = await member();
    const res = await as(mia.token)
      .post('/me/profile-verification', { note: 'I chair three conferences.' })
      .expect(200);
    expect(res.body.status).toBe('pending');
    await as(mia.token).post('/me/profile-verification').expect(409);

    const list = (
      await as(root.token).get('/admin/profile-verifications').expect(200)
    ).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      status: 'pending',
      note: 'I chair three conferences.',
      person: {
        name: 'Mia User',
        affiliation: 'IIT Bombay',
        designation: 'Professor',
      },
    });
    const bell = await as(root.token).get('/me/notifications').expect(200);
    expect(JSON.stringify(bell.body)).toContain('profile_verification_request');
  });

  it('can be withdrawn while waiting', async () => {
    const root = await admin();
    const mia = await member();
    await as(mia.token).post('/me/profile-verification').expect(200);
    const res = await as(mia.token).del('/me/profile-verification').expect(200);
    expect(res.body.status).toBe('none');
    expect(
      (await as(root.token).get('/admin/profile-verifications').expect(200))
        .body,
    ).toHaveLength(0);
  });

  it('approving gives the tick, notifies and emails the member, and cannot be answered twice', async () => {
    const root = await admin();
    const mia = await member();
    await as(mia.token).post('/me/profile-verification').expect(200);
    const [item] = (
      await as(root.token).get('/admin/profile-verifications').expect(200)
    ).body;
    await as(root.token)
      .post(`/admin/profile-verifications/${item.id}/approve`)
      .expect(204);
    await as(root.token)
      .post(`/admin/profile-verifications/${item.id}/approve`)
      .expect(409);

    const mine = await as(mia.token)
      .get('/me/profile-verification')
      .expect(200);
    expect(mine.body.status).toBe('verified');
    // already verified: no new request
    await as(mia.token).post('/me/profile-verification').expect(409);

    const bell = await as(mia.token).get('/me/notifications').expect(200);
    expect(JSON.stringify(bell.body)).toContain(
      'profile_verification_approved',
    );
    await t.sendQueuedEmails();
    const mail = t
      .outbox()
      .find((m) => m.subject === 'Your profile is verified');
    expect(mail?.to).toContain('mia@example.org');

    const resolved = (
      await as(root.token)
        .get('/admin/profile-verifications?status=resolved')
        .expect(200)
    ).body;
    expect(resolved[0].status).toBe('approved');
  });

  it('rejecting needs a reason, emails it, and the member may ask again', async () => {
    const root = await admin();
    const mia = await member();
    await as(mia.token).post('/me/profile-verification').expect(200);
    const [item] = (
      await as(root.token).get('/admin/profile-verifications').expect(200)
    ).body;
    await as(root.token)
      .post(`/admin/profile-verifications/${item.id}/reject`, {})
      .expect(400);
    await as(root.token)
      .post(`/admin/profile-verifications/${item.id}/reject`, {
        reason: 'Please add your ORCID iD.',
      })
      .expect(204);

    const mine = await as(mia.token)
      .get('/me/profile-verification')
      .expect(200);
    expect(mine.body).toMatchObject({
      status: 'rejected',
      reason: 'Please add your ORCID iD.',
    });
    await t.sendQueuedEmails();
    const mail = t
      .outbox()
      .find((m) => m.subject === 'Your profile could not be verified');
    expect(mail?.html).toContain('Please add your ORCID iD.');

    const again = await as(mia.token)
      .post('/me/profile-verification')
      .expect(200);
    expect(again.body.status).toBe('pending');
  });

  it('nobody can give themselves the tick through the profile JSON, and the console is closed to members', async () => {
    const mia = await member();
    await http()
      .patch(api('/me'))
      .set('Authorization', `Bearer ${mia.token}`)
      .send({ details: { profileVerified: true, verifiedProfile: true } })
      .expect(200);
    const mine = await as(mia.token)
      .get('/me/profile-verification')
      .expect(200);
    expect(mine.body.status).toBe('none');
    await as(mia.token).get('/admin/profile-verifications').expect(403);
  });
});
