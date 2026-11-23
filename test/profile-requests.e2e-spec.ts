import request from 'supertest';
import { createTestApp, type TestApp } from './support/test-app.js';

describe('Profile Verification: new institutions and societies', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  afterEach(async () => {
    await t.db.query('delete from profile_requests');
    await t.db.query('delete from institutions');
    await t.db.query('delete from societies');
    await t.reset();
  });

  const http = () => request(t.app.getHttpServer());
  const api = (p: string) => `/api/v1${p}`;

  async function member(email: string) {
    const user = await t.createUser({ email, firstName: 'Mia' });
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

  const save = (token: string, body: object) =>
    http().patch(api('/me')).set('Authorization', `Bearer ${token}`).send(body);

  const pendingInstitution = {
    affiliation: 'GR Conferences',
    details: {
      affiliations: [
        {
          id: 'aff-1',
          institution: 'GR Conferences',
          institutionId: null,
          pending: true,
          primary: true,
        },
      ],
      affiliationPending: true,
      affiliationInstitutionId: null,
    },
  };
  const pendingSociety = {
    details: {
      timeline: [
        {
          id: 'm1',
          type: 'membership',
          societyId: 'other',
          org: 'Asia Research Society',
          societyUrl: 'https://ars.example.org',
          verification: 'pending',
        },
      ],
    },
  };

  const queue = (token: string) =>
    http()
      .get(api('/admin/profile-requests'))
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

  it('files one request per new name and tells the Super Admin', async () => {
    const root = await admin();
    const mia = await member('mia@example.org');
    await save(mia.token, pendingInstitution).expect(200);
    await save(mia.token, pendingInstitution).expect(200); // saved twice: still one

    const res = await queue(root.token);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      kind: 'institution',
      name: 'GR Conferences',
      status: 'pending',
    });
    const bell = await http()
      .get(api('/me/notifications'))
      .set('Authorization', `Bearer ${root.token}`)
      .expect(200);
    const kinds = JSON.stringify(bell.body);
    expect(kinds).toContain('profile_request');
  });

  it('does not file anything for names already approved or without the pending mark', async () => {
    const root = await admin();
    const mia = await member('mia@example.org');
    await save(mia.token, {
      details: {
        affiliations: [
          { institution: 'MIT', institutionId: 'mit', pending: false },
        ],
      },
    }).expect(200);
    expect((await queue(root.token)).body).toHaveLength(0);
  });

  it('approving an institution adds it to the list and clears "Pending review"', async () => {
    const root = await admin();
    const mia = await member('mia@example.org');
    const sam = await member('sam@example.org');
    await save(mia.token, pendingInstitution).expect(200);
    await save(sam.token, {
      ...pendingInstitution,
      affiliation: 'gr  conferences',
      details: {
        ...pendingInstitution.details,
        affiliations: [
          {
            institution: 'gr  conferences',
            institutionId: null,
            pending: true,
          },
        ],
      },
    }).expect(200);

    const list = (await queue(root.token)).body;
    expect(list).toHaveLength(1);
    expect(list[0].requesters).toHaveLength(2);

    await http()
      .post(api(`/admin/profile-requests/${list[0].id}/approve`))
      .set('Authorization', `Bearer ${root.token}`)
      .send({ name: 'GR Conferences Pvt Ltd', country: 'India' })
      .expect(204);

    const inst = await t.db.query<{ name: string; country: string }>(
      `select name, country from institutions`,
    );
    expect(inst.rows).toEqual([
      { name: 'GR Conferences Pvt Ltd', country: 'India' },
    ]);

    const me = await http()
      .get(api('/me'))
      .set('Authorization', `Bearer ${mia.token}`)
      .expect(200);
    expect(me.body.affiliation).toBe('GR Conferences Pvt Ltd');
    expect(me.body.details.affiliationPending).toBe(false);
    expect(me.body.details.affiliations[0]).toMatchObject({
      institution: 'GR Conferences Pvt Ltd',
      pending: false,
    });
    expect(me.body.details.affiliations[0].institutionId).toBeTruthy();

    const bell = await http()
      .get(api('/me/notifications'))
      .set('Authorization', `Bearer ${mia.token}`)
      .expect(200);
    expect(JSON.stringify(bell.body)).toContain('profile_request_approved');

    expect((await queue(root.token)).body).toHaveLength(0);
    const done = await http()
      .get(api('/admin/profile-requests?status=resolved'))
      .set('Authorization', `Bearer ${root.token}`)
      .expect(200);
    expect(done.body[0]).toMatchObject({
      status: 'approved',
      resolvedName: 'GR Conferences Pvt Ltd',
    });
  });

  it('approving a society needs an acronym and marks the membership verified', async () => {
    const root = await admin();
    const mia = await member('mia@example.org');
    await save(mia.token, pendingSociety).expect(200);
    const [item] = (await queue(root.token)).body;
    expect(item).toMatchObject({
      kind: 'society',
      url: 'https://ars.example.org',
    });

    await http()
      .post(api(`/admin/profile-requests/${item.id}/approve`))
      .set('Authorization', `Bearer ${root.token}`)
      .send({})
      .expect(400);
    await http()
      .post(api(`/admin/profile-requests/${item.id}/approve`))
      .set('Authorization', `Bearer ${root.token}`)
      .send({ acronym: 'ARS' })
      .expect(204);

    const soc = await t.db.query<{ acronym: string; url: string }>(
      `select acronym, url from societies`,
    );
    expect(soc.rows).toEqual([
      { acronym: 'ARS', url: 'https://ars.example.org' },
    ]);
    const me = await http()
      .get(api('/me'))
      .set('Authorization', `Bearer ${mia.token}`)
      .expect(200);
    expect(me.body.details.timeline[0].verification).toBe('approved');
  });

  it('can link the name to an entry already on the list', async () => {
    const root = await admin();
    const mia = await member('mia@example.org');
    const created = await http()
      .post(api('/admin/master-data/institutions'))
      .set('Authorization', `Bearer ${root.token}`)
      .send({ name: 'GR Conferences International' })
      .expect(201);
    await save(mia.token, pendingInstitution).expect(200);
    const [item] = (await queue(root.token)).body;
    await http()
      .post(api(`/admin/profile-requests/${item.id}/approve`))
      .set('Authorization', `Bearer ${root.token}`)
      .send({ intoId: created.body.id })
      .expect(204);
    const me = await http()
      .get(api('/me'))
      .set('Authorization', `Bearer ${mia.token}`)
      .expect(200);
    expect(me.body.affiliation).toBe('GR Conferences International');
    const inst = await t.db.query<{ aliases: string[] }>(
      `select aliases from institutions`,
    );
    expect(inst.rows[0].aliases).toContain('GR Conferences');
  });

  it('rejecting needs a reason, tells the member and cannot be done twice', async () => {
    const root = await admin();
    const mia = await member('mia@example.org');
    await save(mia.token, pendingSociety).expect(200);
    const [item] = (await queue(root.token)).body;
    const reject = (body: object) =>
      http()
        .post(api(`/admin/profile-requests/${item.id}/reject`))
        .set('Authorization', `Bearer ${root.token}`)
        .send(body);
    await reject({}).expect(400);
    await reject({ reason: 'Not a professional body' }).expect(204);
    await reject({ reason: 'Not a professional body' }).expect(409);
    await t.sendQueuedEmails();
    const mail = t.outbox().find((m) => m.subject.includes('was not accepted'));
    expect(mail?.to).toContain('mia@example.org');
    expect(mail?.html).toContain('Not a professional body');

    const me = await http()
      .get(api('/me'))
      .set('Authorization', `Bearer ${mia.token}`)
      .expect(200);
    expect(me.body.details.timeline).toEqual([]); // the rejected society is taken out
    const bell = await http()
      .get(api('/me/notifications'))
      .set('Authorization', `Bearer ${mia.token}`)
      .expect(200);
    expect(JSON.stringify(bell.body)).toContain('profile_request_rejected');
  });

  it('research areas: a new secondary needs its primary first, then both are approved', async () => {
    const root = await admin();
    const mia = await member('mia@example.org');
    await save(mia.token, {
      details: {
        primaryArea: 'Maritime Studies',
        primaryAreaPending: true,
        secondaryAreas: ['Port Logistics'],
        pendingSecondaryAreas: ['Port Logistics'],
      },
    }).expect(200);

    const list = (
      await http()
        .get(api('/admin/profile-requests?kind=research_area'))
        .set('Authorization', `Bearer ${root.token}`)
        .expect(200)
    ).body;
    expect(list).toHaveLength(2);
    const primary = list.find(
      (r: { parentName: string | null }) => !r.parentName,
    );
    const secondary = list.find(
      (r: { parentName: string | null }) => r.parentName,
    );
    expect(secondary.parentName).toBe('Maritime Studies');

    const approve = (id: string, body: object) =>
      http()
        .post(api(`/admin/profile-requests/${id}/approve`))
        .set('Authorization', `Bearer ${root.token}`)
        .send(body);
    await approve(secondary.id, {}).expect(409); // its primary is not listed yet
    await approve(primary.id, {}).expect(400); // needs a heading
    await approve(primary.id, { group: 'Social Sciences' }).expect(204);
    await approve(secondary.id, {}).expect(204);

    const rows = await t.db.query<{
      name: string;
      group_label: string | null;
      parent: string | null;
    }>(
      `select a.name, a.group_label, p.name as parent from research_areas a left join research_areas p on p.id = a.parent_id where a.name in ('Maritime Studies','Port Logistics') order by a.name`,
    );
    expect(rows.rows).toEqual([
      {
        name: 'Maritime Studies',
        group_label: 'Social Sciences',
        parent: null,
      },
      { name: 'Port Logistics', group_label: null, parent: 'Maritime Studies' },
    ]);
    const me = await http()
      .get(api('/me'))
      .set('Authorization', `Bearer ${mia.token}`)
      .expect(200);
    expect(me.body.details).toMatchObject({
      primaryAreaPending: false,
      pendingSecondaryAreas: [],
      primaryArea: 'Maritime Studies',
      secondaryAreas: ['Port Logistics'],
    });
  });

  it('research areas: rejecting takes the typed area out of the profile', async () => {
    const root = await admin();
    const mia = await member('mia@example.org');
    await save(mia.token, {
      details: {
        primaryArea: 'Physics',
        primaryAreaPending: false,
        secondaryAreas: ['Dark Cheese'],
        pendingSecondaryAreas: ['Dark Cheese'],
      },
    }).expect(200);
    const [item] = (
      await http()
        .get(api('/admin/profile-requests?kind=research_area'))
        .set('Authorization', `Bearer ${root.token}`)
        .expect(200)
    ).body;
    await http()
      .post(api(`/admin/profile-requests/${item.id}/reject`))
      .set('Authorization', `Bearer ${root.token}`)
      .send({ reason: 'Not a research area' })
      .expect(204);
    const me = await http()
      .get(api('/me'))
      .set('Authorization', `Bearer ${mia.token}`)
      .expect(200);
    expect(me.body.details.secondaryAreas).toEqual([]);
    expect(me.body.details.pendingSecondaryAreas).toEqual([]);
  });

  it('rejecting an institution takes it out of the profile', async () => {
    const root = await admin();
    const mia = await member('mia@example.org');
    await save(mia.token, pendingInstitution).expect(200);
    const [item] = (await queue(root.token)).body;
    await http()
      .post(api(`/admin/profile-requests/${item.id}/reject`))
      .set('Authorization', `Bearer ${root.token}`)
      .send({ reason: 'Please use the full name' })
      .expect(204);
    const me = await http()
      .get(api('/me'))
      .set('Authorization', `Bearer ${mia.token}`)
      .expect(200);
    expect(me.body.details.affiliations).toEqual([]);
    expect(me.body.details.affiliationPending).toBe(false);
    expect(me.body.affiliation).toBeNull();
  });

  it('is closed to everyone who is not a Super Admin', async () => {
    const mia = await member('mia@example.org');
    await http()
      .get(api('/admin/profile-requests'))
      .set('Authorization', `Bearer ${mia.token}`)
      .expect(403);
  });
});
