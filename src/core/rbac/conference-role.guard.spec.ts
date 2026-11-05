import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from '../auth/auth-user.js';
import { AppException } from '../errors/app.exception.js';
import type { AccessService } from './access.service.js';
import { ConferenceRoleGuard } from './conference-role.guard.js';
import type { MemberRole } from './conf-roles.decorator.js';

const CONFERENCE_ID = '7b0c2a52-3c1f-4e8a-9f1e-2d6a1b9c0e11';
const user: AuthUser = { id: 'u1', sessionId: 's1', mfa: false };

function setup(roles: MemberRole[] | undefined, allowed = true) {
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(roles);
  const access = {
    assertConfRole: vi.fn(async () => {
      if (!allowed) throw AppException.forbidden();
    }),
  };
  const guard = new ConferenceRoleGuard(
    reflector,
    access as unknown as AccessService,
  );
  const context = (params: Record<string, string>, withUser = true) =>
    ({
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
      switchToHttp: () => ({
        getRequest: () => ({ params, user: withUser ? user : undefined }),
      }),
    }) as unknown as ExecutionContext;
  return { guard, access, context };
}

describe('ConferenceRoleGuard', () => {
  it('lets routes without @ConfRoles() through without a database call', async () => {
    const { guard, access, context } = setup(undefined);
    await expect(guard.canActivate(context({}))).resolves.toBe(true);
    expect(access.assertConfRole).not.toHaveBeenCalled();
  });

  it('checks the roles against the :conferenceId parameter', async () => {
    const { guard, access, context } = setup(['chair', 'track_chair']);
    await expect(
      guard.canActivate(context({ conferenceId: CONFERENCE_ID })),
    ).resolves.toBe(true);
    expect(access.assertConfRole).toHaveBeenCalledWith(user, CONFERENCE_ID, [
      'chair',
      'track_chair',
    ]);
  });

  it('rejects members without the role', async () => {
    const { guard, context } = setup(['chair'], false);
    await expect(
      guard.canActivate(context({ conferenceId: CONFERENCE_ID })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('answers 404 for a malformed conference id', async () => {
    const { guard, access, context } = setup(['chair']);
    await expect(
      guard.canActivate(context({ conferenceId: 'not-a-uuid' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(access.assertConfRole).not.toHaveBeenCalled();
  });

  it('fails loudly when the route has no :conferenceId parameter', async () => {
    const { guard, context } = setup(['chair']);
    await expect(
      guard.canActivate(context({ id: CONFERENCE_ID })),
    ).rejects.toThrow(/needs a :conferenceId route parameter/);
  });
});
