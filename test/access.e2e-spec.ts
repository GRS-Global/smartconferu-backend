import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../src/core/auth/auth-user.js';
import { AccessService } from '../src/core/rbac/access.service.js';
import { createTestApp, type TestApp } from './support/test-app.js';

describe('AccessService', () => {
  let t: TestApp;
  let access: AccessService;
  let chair: AuthUser;
  let outsider: AuthUser;
  let conferenceId: string;

  const asAuthUser = (id: string, mfa = false): AuthUser => ({
    id,
    sessionId: randomUUID(),
    mfa,
  });

  beforeAll(async () => {
    t = await createTestApp();
    access = t.app.get(AccessService);
    chair = asAuthUser((await t.createUser()).id);
    outsider = asAuthUser((await t.createUser()).id);
    const { rows } = await t.db.query<{ id: string }>(
      `insert into conferences (slug, acronym, title, created_by) values ('rbac-2027', 'RBAC 2027', 'Roles', $1) returning id`,
      [chair.id],
    );
    conferenceId = rows[0].id;
    await t.db.query(
      `insert into conference_members (conference_id, user_id, role, status) values ($1, $2, 'chair', 'active')`,
      [conferenceId, chair.id],
    );
  });
  afterAll(() => t.close());

  it('allows an active member with the role', async () => {
    await expect(
      access.hasConfRole(chair, conferenceId, ['chair']),
    ).resolves.toBe(true);
  });

  it('refuses a role the member does not have', async () => {
    await expect(
      access.hasConfRole(chair, conferenceId, ['reviewer']),
    ).resolves.toBe(false);
  });

  it('refuses a non-member', async () => {
    await expect(
      access.hasConfRole(outsider, conferenceId, ['chair', 'track_chair']),
    ).resolves.toBe(false);
  });

  it('refuses a member whose invitation is not accepted', async () => {
    const invited = asAuthUser((await t.createUser()).id);
    await t.db.query(
      `insert into conference_members (conference_id, user_id, role, status) values ($1, $2, 'reviewer', 'invited')`,
      [conferenceId, invited.id],
    );
    await expect(
      access.hasConfRole(invited, conferenceId, ['reviewer']),
    ).resolves.toBe(false);
  });

  it('allows a super admin on any conference, in a two-step-verified session', async () => {
    const { id } = await t.createUser();
    await t.db.query('update users set is_super_admin = true where id = $1', [
      id,
    ]);
    await expect(
      access.hasConfRole(asAuthUser(id, true), conferenceId, ['chair']),
    ).resolves.toBe(true);
    // The same account with only a password gets no admin powers.
    await expect(
      access.hasConfRole(asAuthUser(id, false), conferenceId, ['chair']),
    ).resolves.toBe(false);
    await expect(access.isSuperAdmin(asAuthUser(id, false))).resolves.toBe(
      false,
    );
  });

  it('refuses a disabled account, even a super admin', async () => {
    const admin = asAuthUser((await t.createUser()).id, true);
    await t.db.query(
      `update users set is_super_admin = true, status = 'disabled' where id = $1`,
      [admin.id],
    );
    await expect(
      access.hasConfRole(admin, conferenceId, ['chair']),
    ).resolves.toBe(false);
    await expect(access.isSuperAdmin(admin)).resolves.toBe(false);
  });
});
