import request from 'supertest';
import {
  createTestApp,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

describe('/api/v1/me', () => {
  let t: TestApp;
  let user: TestUser;
  let token: string;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  beforeEach(async () => {
    user = await t.createUser({
      email: 'ada@example.test',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    token = await t.tokenFor(user.id);
  });
  afterEach(() => t.reset());

  const http = () => request(t.app.getHttpServer());

  it('rejects a request without a token', async () => {
    const res = await http().get('/api/v1/me').expect(401);
    expect(res.body).toMatchObject({ statusCode: 401, code: 'AUTH_REQUIRED' });
    expect(res.body.requestId).toEqual(res.headers['x-request-id']);
  });

  describe('GET /me', () => {
    it("returns the signed-in user's profile", async () => {
      const res = await http()
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body).toMatchObject({
        id: user.id,
        email: 'ada@example.test',
        emailVerified: true,
        firstName: 'Ada',
        lastName: 'Lovelace',
        designation: null,
        isSuperAdmin: false,
        details: {},
      });
      expect(res.body.createdAt).toMatch(
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
      );
    });
  });

  describe('PATCH /me', () => {
    it('updates profile columns and private details together', async () => {
      const res = await http()
        .patch('/api/v1/me')
        .set('Authorization', `Bearer ${token}`)
        .send({
          firstName: '  Augusta ',
          designation: '   ',
          affiliation: 'Analytical Engine Society',
          orcidId: '0000-0002-1825-0097',
          details: { phone: '+44 20 0000 0000' },
        })
        .expect(200);
      expect(res.body).toMatchObject({
        firstName: 'Augusta',
        lastName: 'Lovelace',
        designation: null,
        affiliation: 'Analytical Engine Society',
        orcidId: '0000-0002-1825-0097',
        details: { phone: '+44 20 0000 0000' },
      });

      const again = await http()
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(again.body).toEqual(res.body);
    });

    it('rejects unknown and invalid fields with field-level details', async () => {
      const res = await http()
        .patch('/api/v1/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ firstName: null, orcidId: '1234', isSuperAdmin: true })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      const fields = (res.body.details as { field: string }[])
        .map((d) => d.field)
        .sort();
      expect(fields).toEqual(['firstName', 'isSuperAdmin', 'orcidId']);
    });

    it("refuses a photo outside the user's own folder", async () => {
      const res = await http()
        .patch('/api/v1/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ photoPath: 'someone-else/photo.jpg' })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /me/conferences', () => {
    it('lists the conferences where the user has a role', async () => {
      const { rows } = await t.db.query<{ id: string }>(
        `insert into conferences (slug, acronym, title, created_by)
         values ('icx-2027', 'ICX 2027', 'International Conference X', $1) returning id`,
        [user.id],
      );
      await t.db.query(
        `insert into conference_members (conference_id, user_id, role, status) values ($1, $2, 'chair', 'active')`,
        [rows[0].id, user.id],
      );

      const res = await http()
        .get('/api/v1/me/conferences')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body).toEqual([
        expect.objectContaining({
          slug: 'icx-2027',
          role: 'chair',
          memberStatus: 'active',
        }),
      ]);

      const other = await t.createUser();
      const otherRes = await http()
        .get('/api/v1/me/conferences')
        .set('Authorization', `Bearer ${await t.tokenFor(other.id)}`)
        .expect(200);
      expect(otherRes.body).toEqual([]);
    });
  });
});
