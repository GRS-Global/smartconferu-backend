import { HttpStatus, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AuthUser } from '../auth/auth-user.js';
import { DatabaseService } from '../database/database.service.js';
import type { Executor } from '../database/database.types.js';
import { conferenceMembers, userMfa, users } from '../database/schema/index.js';
import { AppException, ErrorCode } from '../errors/app.exception.js';
import type { MemberRole } from './conf-roles.decorator.js';

/**
 * Who may do what. Every permission decision in the API goes through here, so the rules live in
 * one place and are tested once.
 *
 * Super-admin powers count only in a session that passed two-step verification: a stolen
 * password alone never reaches admin features.
 */
@Injectable()
export class AccessService {
  constructor(private readonly database: DatabaseService) {}

  /** A super admin acting with a two-step-verified session. */
  async isSuperAdmin(
    user: AuthUser,
    executor: Executor = this.database.db,
  ): Promise<boolean> {
    return user.mfa && (await this.isSuperAdminAccount(user.id, executor));
  }

  /** Throws unless the user may use super-admin features right now, saying what is missing. */
  async assertSuperAdmin(user: AuthUser): Promise<void> {
    const [row] = await this.database.db
      .select({
        isSuperAdmin: users.isSuperAdmin,
        mfaOn: sql<boolean>`${userMfa.enabledAt} is not null`,
      })
      .from(users)
      .leftJoin(userMfa, eq(userMfa.userId, users.id))
      .where(and(eq(users.id, user.id), eq(users.status, 'active')));
    if (!row?.isSuperAdmin) {
      throw AppException.forbidden();
    }
    if (!row.mfaOn) {
      throw new AppException(
        HttpStatus.FORBIDDEN,
        ErrorCode.AUTH_MFA_SETUP_REQUIRED,
        'Turn on two-step verification to use admin features.',
      );
    }
    if (!user.mfa) {
      throw new AppException(
        HttpStatus.FORBIDDEN,
        ErrorCode.AUTH_MFA_REQUIRED,
        'Sign in again with your authenticator app to use admin features.',
      );
    }
  }

  /** True if the user is a (verified) super admin or an active member of the conference in one of `roles`. */
  async hasConfRole(
    user: AuthUser,
    conferenceId: string,
    roles: readonly MemberRole[],
    executor: Executor = this.database.db,
  ): Promise<boolean> {
    const [row] = await executor
      .select({
        isSuperAdmin: users.isSuperAdmin,
        isMember: sql<boolean>`exists (
          select 1 from ${conferenceMembers}
          where ${and(
            eq(conferenceMembers.conferenceId, conferenceId),
            eq(conferenceMembers.userId, user.id),
            eq(conferenceMembers.status, 'active'),
            inArray(conferenceMembers.role, [...roles]),
          )})`,
      })
      .from(users)
      .where(and(eq(users.id, user.id), eq(users.status, 'active')));
    return (
      row !== undefined && ((row.isSuperAdmin && user.mfa) || row.isMember)
    );
  }

  /** Throws 403 unless hasConfRole() is true. */
  async assertConfRole(
    user: AuthUser,
    conferenceId: string,
    roles: readonly MemberRole[],
    executor?: Executor,
  ): Promise<void> {
    if (!(await this.hasConfRole(user, conferenceId, roles, executor))) {
      throw AppException.forbidden();
    }
  }

  private async isSuperAdminAccount(
    userId: string,
    executor: Executor,
  ): Promise<boolean> {
    const [row] = await executor
      .select({ isSuperAdmin: users.isSuperAdmin })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.status, 'active')));
    return row?.isSuperAdmin === true;
  }
}
