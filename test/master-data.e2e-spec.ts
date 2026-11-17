import request from 'supertest';
import { createTestApp, type TestApp } from './support/test-app.js';

describe('Master data and user accounts (Super Admin)', () => {
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
  });

  describe('lists everyone reads', () => {
    it('come from the lists the app shipped with', async () => {
      const societies = await http()
        .get(api('/master-data/societies'))
        .expect(200);
      expect(societies.body).toHaveLength(11);
      expect(societies.body[0]).toMatchObject({
        key: expect.any(String),
        acronym: expect.any(String),
        status: 'active',
      });

      const found = await http()
        .get(api('/master-data/institutions?search=IITB'))
        .expect(200);
      expect(found.body.map((i: { name: string }) => i.name)).toEqual([
        'Indian Institute of Technology Bombay',
      ]);

      const areas = await http()
        .get(api('/master-data/research-areas'))
        .expect(200);
      const computing = areas.body.find(
        (g: { label: string }) => g.label === 'Computing & Engineering',
      );
      expect(computing.areas[0]).toMatchObject({
        name: 'Computer Science & AI',
        subareas: expect.arrayContaining([
          expect.objectContaining({ name: 'Artificial Intelligence' }),
        ]),
      });
    });

    it('are changed only by a super admin in a verified session', async () => {
      const user = await t.createUser();
      const token = await t.tokenFor(user.id, true);
      await as(token)
        .post('/admin/master-data/societies', { name: 'X', acronym: 'X' })
        .expect(403);
      const admin = await t.createUser();
      await t.db.query('update users set is_super_admin = true where id = $1', [
        admin.id,
      ]);
      const unverified = await as(await t.tokenFor(admin.id, false))
        .get('/admin/master-data/societies')
        .expect(403);
      expect(unverified.body.code).toBe('AUTH_MFA_REQUIRED');
    });
  });

  it('societies: add, refuse a duplicate acronym, edit, deactivate', async () => {
    const admin = await superAdmin();
    const created = await as(admin.token)
      .post('/admin/master-data/societies', {
        name: 'Society for Industrial and Applied Mathematics',
        acronym: 'SIAM',
        url: 'https://www.siam.org',
      })
      .expect(201);
    expect(created.body).toMatchObject({ key: 'siam', status: 'active' });

    const dup = await as(admin.token)
      .post('/admin/master-data/societies', { name: 'Other', acronym: 'siam' })
      .expect(409);
    expect(dup.body.code).toBe('CONFLICT');
    await as(admin.token)
      .post('/admin/master-data/societies', {
        name: 'Bad',
        acronym: 'BAD',
        url: 'not a url',
      })
      .expect(400);

    await as(admin.token)
      .patch(`/admin/master-data/societies/${created.body.id}`, {
        status: 'inactive',
      })
      .expect(200);
    const open = await http().get(api('/master-data/societies')).expect(200);
    expect(
      open.body.some((s: { acronym: string }) => s.acronym === 'SIAM'),
    ).toBe(false);
    const all = await as(admin.token)
      .get('/admin/master-data/societies')
      .expect(200);
    expect(
      all.body.find((s: { acronym: string }) => s.acronym === 'SIAM'),
    ).toMatchObject({ status: 'inactive' });
  });

  it('institutions: add, count people, merge a duplicate, restore it', async () => {
    const admin = await superAdmin();
    const kept = await as(admin.token)
      .post('/admin/master-data/institutions', {
        name: 'University of Testing',
        aliases: ['UoT', ' uot ', ''],
        country: 'India',
        departments: ['Department of Physics'],
      })
      .expect(201);
    expect(kept.body.aliases).toEqual(['UoT']);
    const dup = await as(admin.token)
      .post('/admin/master-data/institutions', {
        name: 'Testing University',
        departments: ['Department of Chemistry'],
      })
      .expect(201);
    const member = await t.createUser();
    await t.db.query(
      `update profiles set affiliation = 'university of testing' where id = $1`,
      [member.id],
    );

    const merged = await as(admin.token)
      .post(`/admin/master-data/institutions/${dup.body.id}/merge`, {
        intoId: kept.body.id,
      })
      .expect(200);
    expect(merged.body.aliases).toEqual(['UoT', 'Testing University']);
    expect(merged.body.departments).toEqual([
      'Department of Physics',
      'Department of Chemistry',
    ]);

    const list = await as(admin.token)
      .get('/admin/master-data/institutions?search=testing')
      .expect(200);
    const byName = Object.fromEntries(
      list.body.map((i: { name: string }) => [i.name, i]),
    );
    expect(byName['University of Testing'].people).toBe(1);
    expect(byName['Testing University']).toMatchObject({
      status: 'retired',
      mergedInto: { id: kept.body.id, name: 'University of Testing' },
    });
    // The search still finds the kept one by the duplicate's name; the retired one is hidden.
    const open = await http()
      .get(api('/master-data/institutions?search=Testing University'))
      .expect(200);
    expect(open.body.map((i: { name: string }) => i.name)).toEqual([
      'University of Testing',
    ]);

    const restored = await as(admin.token)
      .patch(`/admin/master-data/institutions/${dup.body.id}`, {
        status: 'active',
      })
      .expect(200);
    expect(restored.body).toMatchObject({ status: 'active', mergedInto: null });
  });

  it('research areas: add, rename (conferences follow), retire', async () => {
    const admin = await superAdmin();
    const chair = await t.createUser();
    const conference = await http()
      .post(api('/conferences'))
      .set('Authorization', `Bearer ${await t.tokenFor(chair.id)}`)
      .send({
        acronym: 'ICX 2027',
        title: 'International Conference X 2027',
        startDate: '2027-06-01',
        endDate: '2027-06-03',
      })
      .expect(201);
    await t.db.query(
      `update conferences set primary_area = 'Computer Science & AI', secondary_area = 'Internet of Things' where id = $1`,
      [conference.body.id],
    );

    const tree = await as(admin.token)
      .get('/admin/master-data/research-areas')
      .expect(200);
    const cs = tree.body[0].areas.find(
      (a: { name: string }) => a.name === 'Computer Science & AI',
    );
    const iot = cs.subareas.find(
      (s: { name: string }) => s.name === 'Internet of Things',
    );
    expect(cs.conferences).toBe(1);
    expect(iot.conferences).toBe(1);

    await as(admin.token)
      .post('/admin/master-data/research-areas', {
        name: 'Quantum Machine Learning',
        parentId: cs.id,
      })
      .expect(201);
    await as(admin.token)
      .post('/admin/master-data/research-areas', {
        name: 'internet of things',
        parentId: cs.id,
      })
      .expect(409);
    await as(admin.token)
      .post('/admin/master-data/research-areas', { name: 'No place' })
      .expect(400);

    const renamed = await as(admin.token)
      .patch(`/admin/master-data/research-areas/${iot.id}`, {
        name: 'Internet of Things & Sensor Networks',
      })
      .expect(200);
    expect(renamed.body.conferencesRenamed).toBe(1);
    const { rows } = await t.db.query<{ secondary_area: string }>(
      'select secondary_area from conferences where id = $1',
      [conference.body.id],
    );
    expect(rows[0].secondary_area).toBe('Internet of Things & Sensor Networks');

    await as(admin.token)
      .patch(`/admin/master-data/research-areas/${iot.id}`, {
        status: 'retired',
      })
      .expect(200);
    const open = await http()
      .get(api('/master-data/research-areas'))
      .expect(200);
    const names = open.body
      .flatMap((g: { areas: { subareas: { name: string }[] }[] }) => g.areas)
      .flatMap((a: { subareas: { name: string }[] }) => a.subareas)
      .map((s: { name: string }) => s.name);
    expect(names).toContain('Quantum Machine Learning');
    expect(names).not.toContain('Internet of Things & Sensor Networks');
  });

  describe('user accounts', () => {
    it('suspend ends every session and blocks sign-in; reactivate lets them back', async () => {
      const admin = await superAdmin();
      const user = await t.createUser({ firstName: 'Sam', lastName: 'User' });
      const signIn = () =>
        http()
          .post(api('/auth/sign-in'))
          .send({ email: user.email, password: user.password });
      await signIn().expect(200);

      const suspended = await as(admin.token)
        .post(`/admin/users/${user.id}/suspend`, { reason: 'Spam' })
        .expect(200);
      expect(suspended.body).toMatchObject({
        name: 'Sam User',
        status: 'disabled',
      });
      const { rows } = await t.db.query<{ open: number }>(
        'select count(*)::int as open from sessions where user_id = $1 and revoked_at is null',
        [user.id],
      );
      expect(rows[0].open).toBe(0);
      const refused = await signIn().expect(403);
      expect(refused.body.code).toBe('AUTH_ACCOUNT_DISABLED');

      await as(admin.token)
        .post(`/admin/users/${user.id}/reactivate`)
        .expect(200);
      await signIn().expect(200);

      const detail = await as(admin.token)
        .get(`/admin/users/${user.id}`)
        .expect(200);
      expect(detail.body).toMatchObject({ status: 'active', conferences: [] });
      expect(
        detail.body.recentActivity.map((a: { action: string }) => a.action),
      ).toContain('auth.sign_in');
      const log = await as(admin.token)
        .get(`/admin/activity?actorId=${admin.id}`)
        .expect(200);
      expect(log.body.data.map((a: { action: string }) => a.action)).toEqual([
        'admin.user_reactivated',
        'admin.user_suspended',
      ]);
    });

    it("can't suspend yourself or another super admin", async () => {
      const admin = await superAdmin();
      const other = await superAdmin();
      const self = await as(admin.token)
        .post(`/admin/users/${admin.id}/suspend`)
        .expect(422);
      expect(self.body.code).toBe('BUSINESS_RULE');
      await as(admin.token)
        .post(`/admin/users/${other.id}/suspend`)
        .expect(422);
    });
  });
});
