import request from 'supertest';
import {
  createTestApp,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

/** The approval queues' working state: claims, internal notes, and "Ask for info". */
describe('Admin › queue claims, notes and "Ask for info"', () => {
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

  async function superAdmin(firstName: string) {
    const user = await t.createUser({ firstName, lastName: 'Admin' });
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
    put: (path: string) =>
      http().put(api(path)).set('Authorization', `Bearer ${token}`).send({}),
    delete: (path: string) =>
      http().delete(api(path)).set('Authorization', `Bearer ${token}`),
  });

  async function setup() {
    const chair = await person({ firstName: 'Carla', lastName: 'Chair' });
    const ann = await superAdmin('Ann');
    const bob = await superAdmin('Bob');
    const created = await as(chair.token)
      .post('/conferences', {
        acronym: 'ICX 2027',
        title: 'International Conference X 2027',
        startDate: '2027-06-01',
        endDate: '2027-06-03',
      })
      .expect(201);
    return { chair, ann, bob, id: created.body.id as string };
  }

  it('claims an item, lets another admin take it over, and releases it', async () => {
    const { ann, bob, id } = await setup();
    await as(ann.token).put(`/admin/queues/requests/${id}/claim`).expect(204);
    let state = await as(bob.token).get('/admin/queues/requests').expect(200);
    expect(state.body.claims).toEqual([
      expect.objectContaining({
        itemId: id,
        admin: { id: ann.id, name: 'Ann Admin' },
      }),
    ]);

    await as(bob.token).put(`/admin/queues/requests/${id}/claim`).expect(204);
    state = await as(ann.token).get('/admin/queues/requests').expect(200);
    expect(state.body.claims[0].admin.id).toBe(bob.id);

    await as(bob.token)
      .delete(`/admin/queues/requests/${id}/claim`)
      .expect(204);
    state = await as(ann.token).get('/admin/queues/requests').expect(200);
    expect(state.body.claims).toEqual([]);
  });

  it('keeps internal notes per item, oldest first', async () => {
    const { ann, bob, id } = await setup();
    const first = await as(ann.token)
      .post(`/admin/queues/requests/${id}/notes`, {
        text: '  Checked the web page.  ',
      })
      .expect(201);
    expect(first.body).toMatchObject({
      itemId: id,
      kind: 'note',
      text: 'Checked the web page.',
      author: { id: ann.id, name: 'Ann Admin' },
    });
    await as(bob.token)
      .post(`/admin/queues/requests/${id}/notes`, { text: 'Looks fine to me.' })
      .expect(201);
    const state = await as(ann.token).get('/admin/queues/requests').expect(200);
    expect(state.body.notes.map((n: { text: string }) => n.text)).toEqual([
      'Checked the web page.',
      'Looks fine to me.',
    ]);
    await as(ann.token)
      .post(`/admin/queues/requests/${id}/notes`, { text: '   ' })
      .expect(400);
    await as(ann.token).get('/admin/queues/everything').expect(400);
  });

  it('"Ask for info" tells the chair (notification and email) and joins the thread', async () => {
    const { ann, chair, id } = await setup();
    await as(ann.token)
      .post(`/admin/conferences/${id}/ask-info`, {
        message: 'Which society organises it?',
      })
      .expect(204);

    const state = await as(ann.token).get('/admin/queues/requests').expect(200);
    expect(state.body.notes).toEqual([
      expect.objectContaining({
        kind: 'message',
        text: 'Which society organises it?',
      }),
    ]);
    const { rows } = await t.db.query<{ title: string }>(
      'select title from notifications where user_id = $1',
      [chair.id],
    );
    expect(rows.map((r) => r.title)).toContain(
      'More information needed: ICX 2027',
    );
    await t.sendQueuedEmails();
    const mail = t.outbox().find((m) => m.to === chair.email);
    expect(mail?.subject).toBe('About your request for ICX 2027');
    expect(mail?.html).toContain('Which society organises it?');

    // Still waiting; once decided, there is nothing to ask any more.
    const list = await as(ann.token)
      .get('/admin/conferences?status=pending_approval')
      .expect(200);
    expect(list.body.map((c: { id: string }) => c.id)).toContain(id);
    await as(ann.token)
      .post(`/admin/conferences/${id}/decision`, { approve: true })
      .expect(204);
    await as(ann.token)
      .post(`/admin/conferences/${id}/ask-info`, { message: 'Too late?' })
      .expect(422);
  });

  it('is only for super admins', async () => {
    const { chair, id } = await setup();
    await as(chair.token).get('/admin/queues/requests').expect(403);
    await as(chair.token).put(`/admin/queues/requests/${id}/claim`).expect(403);
    await as(chair.token)
      .post(`/admin/conferences/${id}/ask-info`, { message: 'Hi' })
      .expect(403);
  });
});
