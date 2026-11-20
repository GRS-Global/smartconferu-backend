import request from 'supertest';
import {
  createTestApp,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

/** Support actions on one account: signed-in devices, "Reset 2-step", "Merge accounts". */
describe('Admin › user support actions', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  afterEach(() => t.reset());

  const http = () => request(t.app.getHttpServer());
  const api = (path: string) => `/api/v1${path}`;

  async function superAdmin() {
    const user = await t.createUser({ firstName: 'Super', lastName: 'Admin' });
    await t.db.query('update users set is_super_admin = true where id = $1', [
      user.id,
    ]);
    await t.db.query(
      `insert into user_mfa (user_id, totp_secret, enabled_at) values ($1, 'x', now())`,
      [user.id],
    );
    return {
      ...user,
      token: await t.tokenFor(user.id, true),
      steppedUp: await t.steppedUpToken(user.id),
    };
  }

  const as = (token: string) => ({
    get: (path: string) =>
      http().get(api(path)).set('Authorization', `Bearer ${token}`),
    post: (path: string, body?: object) =>
      http()
        .post(api(path))
        .set('Authorization', `Bearer ${token}`)
        .send(body ?? {}),
    delete: (path: string) =>
      http().delete(api(path)).set('Authorization', `Bearer ${token}`),
  });

  async function signIn(user: TestUser) {
    return http()
      .post(api('/auth/sign-in'))
      .send({ email: user.email, password: user.password })
      .expect(200);
  }

  it('lists where a user is signed in and signs one device out', async () => {
    const admin = await superAdmin();
    const user = await t.createUser();
    await signIn(user);
    await signIn(user);
    const list = await as(admin.token)
      .get(`/admin/users/${user.id}/sessions`)
      .expect(200);
    expect(list.body).toHaveLength(2);
    await as(admin.token)
      .delete(`/admin/users/${user.id}/sessions/${list.body[0].id}`)
      .expect(204);
    const after = await as(admin.token)
      .get(`/admin/users/${user.id}/sessions`)
      .expect(200);
    expect(after.body).toHaveLength(1);
    await as(admin.token)
      .delete(`/admin/users/${user.id}/sessions/${list.body[0].id}`)
      .expect(404);
  });

  it('"Reset 2-step" removes the authenticator app (after a step-up) and emails the user', async () => {
    const admin = await superAdmin();
    const user = await t.createUser();
    await t.db.query(
      `insert into user_mfa (user_id, totp_secret, enabled_at) values ($1, 'x', now())`,
      [user.id],
    );
    const ask = await as(admin.token)
      .post(`/admin/users/${user.id}/reset-mfa`)
      .expect(403);
    expect(ask.body.code).toBe('AUTH_STEP_UP_REQUIRED');
    await as(admin.steppedUp)
      .post(`/admin/users/${user.id}/reset-mfa`)
      .expect(204);
    const { rows } = await t.db.query(
      'select 1 from user_mfa where user_id = $1',
      [user.id],
    );
    expect(rows).toEqual([]);
    expect(t.outbox().at(-1)).toMatchObject({
      to: user.email,
      subject: 'Your two-step verification was reset',
    });
    await as(admin.steppedUp)
      .post(`/admin/users/${admin.id}/reset-mfa`)
      .expect(422);
  });

  it('"Merge accounts" moves everything to the kept account and closes the other', async () => {
    const admin = await superAdmin();
    const keep = await t.createUser({ firstName: 'Ada', lastName: 'Lovelace' });
    const other = await t.createUser({ firstName: 'A.', lastName: 'Lovelace' });
    const created = await http()
      .post(api('/conferences'))
      .set('Authorization', `Bearer ${await t.tokenFor(other.id)}`)
      .send({ acronym: 'ICX 2027', title: 'International Conference X 2027' })
      .expect(201);
    const conferenceId = created.body.id as string;

    await as(admin.token)
      .post(`/admin/users/${keep.id}/merge`, { otherUserId: other.id })
      .expect(403);
    await as(admin.steppedUp)
      .post(`/admin/users/${keep.id}/merge`, { otherUserId: other.id })
      .expect(204);

    const conf = await t.db.query<{ created_by: string }>(
      'select created_by from conferences where id = $1',
      [conferenceId],
    );
    expect(conf.rows[0].created_by).toBe(keep.id);
    const members = await t.db.query<{ user_id: string }>(
      'select user_id from conference_members where conference_id = $1',
      [conferenceId],
    );
    expect(members.rows.every((m) => m.user_id === keep.id)).toBe(true);
    const closed = await t.db.query<{ status: string; email: string | null }>(
      'select status, email from users where id = $1',
      [other.id],
    );
    expect(closed.rows[0]).toEqual({ status: 'disabled', email: null });
    const details = await t.db.query<{ data: { mergedEmails: string[] } }>(
      'select data from profile_details where user_id = $1',
      [keep.id],
    );
    expect(details.rows[0].data.mergedEmails).toEqual([other.email]);
    expect(
      t
        .outbox()
        .map((m) => m.to)
        .sort(),
    ).toEqual([keep.email, other.email].sort());
    // The closed account can't sign in any more.
    await http()
      .post(api('/auth/sign-in'))
      .send({ email: other.email, password: other.password })
      .expect(401);
  });

  it('"View as" gives a read-only token as the person, with the reason logged', async () => {
    const admin = await superAdmin();
    const user = await t.createUser({ firstName: 'Ada', lastName: 'Lovelace' });
    await as(admin.token)
      .post(`/admin/users/${user.id}/view-as`, { reason: 'Ticket 4182' })
      .expect(403);
    const res = await as(admin.steppedUp)
      .post(`/admin/users/${user.id}/view-as`, { reason: 'Ticket 4182' })
      .expect(200);
    expect(res.body.user).toMatchObject({ id: user.id, name: 'Ada Lovelace' });
    const view = res.body.accessToken as string;

    const me = await as(view).get('/me').expect(200);
    expect(me.body.id).toBe(user.id);
    const blocked = await as(view)
      .post('/conferences', { acronym: 'NOPE 1', title: 'Not allowed' })
      .expect(403);
    expect(blocked.body.code).toBe('SUPPORT_VIEW_READ_ONLY');
    await as(view).get('/auth/mfa').expect(403);
    await as(view).get('/admin/users').expect(403);

    const logged = await t.db.query<{ data: { reason: string } }>(
      `select data from audit_log where action = 'admin.user_viewed_as' and entity_id = $1`,
      [user.id],
    );
    expect(logged.rows[0].data.reason).toBe('Ticket 4182');
    await as(admin.steppedUp)
      .post(`/admin/users/${admin.id}/view-as`, { reason: 'Myself?' })
      .expect(422);
  });

  it('refuses to merge an account into itself or a super admin into another', async () => {
    const admin = await superAdmin();
    const keep = await t.createUser();
    await as(admin.steppedUp)
      .post(`/admin/users/${keep.id}/merge`, { otherUserId: keep.id })
      .expect(422);
    await as(admin.steppedUp)
      .post(`/admin/users/${keep.id}/merge`, { otherUserId: admin.id })
      .expect(422);
  });
});
