import { HttpStatus, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AuthUser } from '../auth/auth-user.js';
import { DatabaseService } from '../database/database.service.js';
import type { Executor } from '../database/database.types.js';
import {
  conferenceMembers,
  conferences,
  reviewAssignments,
  submissionAuthors,
  submissions,
  users,
} from '../database/schema/index.js';
import { AppException, ErrorCode } from '../errors/app.exception.js';
import * as rules from './access-rules.js';
import { authoredBy } from './authorship.js';
import type {
  ConferenceAccess,
  MemberRole,
  SubmissionAccess,
} from './access-rules.js';

export {
  CFP_ROLES,
  CHAIR_ROLES,
  type ConferenceAccess,
  type SubmissionAccess,
} from './access-rules.js';

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
      .select({ isSuperAdmin: users.isSuperAdmin })
      .from(users)
      .where(and(eq(users.id, user.id), eq(users.status, 'active')));
    if (!row?.isSuperAdmin) {
      throw AppException.forbidden();
    }
    // The second step is the authenticator app, or (without one) the code emailed at a password
    // sign-in; either way the session is marked verified.
    if (!user.mfa) {
      throw new AppException(
        HttpStatus.FORBIDDEN,
        ErrorCode.AUTH_MFA_REQUIRED,
        'Sign in to the admin console with your password and the code we email you to use admin features.',
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

  /**
   * The user's standing in a conference; undefined when the conference doesn't exist (or is
   * deleted, unless the user is a super admin).
   */
  async conferenceAccess(
    user: AuthUser,
    conferenceId: string,
    executor: Executor = this.database.db,
  ): Promise<ConferenceAccess | undefined> {
    const [row] = await executor
      .select({
        status: conferences.status,
        createdBy: conferences.createdBy,
        superAdminAccount: sql<boolean>`coalesce((
          select ${users.isSuperAdmin} from ${users}
          where ${users.id} = ${user.id} and ${users.status} = 'active'), false)`,
        activeRoles: sql<MemberRole[]>`coalesce((
          select array_agg(distinct ${conferenceMembers.role}::text)
          from ${conferenceMembers}
          where ${conferenceMembers.conferenceId} = ${conferenceId}
            and ${conferenceMembers.userId} = ${user.id}
            and ${conferenceMembers.status} = 'active'), '{}')`,
        isTeamMember: sql<boolean>`exists (
          select 1 from ${conferenceMembers}
          where ${conferenceMembers.conferenceId} = ${conferenceId}
            and ${conferenceMembers.userId} = ${user.id}
            and ${conferenceMembers.status} <> 'removed')`,
        isAuthor: sql<boolean>`exists (
          select 1 from ${submissions}
          where ${submissions.conferenceId} = ${conferenceId}
            and ${authoredBy(user.id)})`,
      })
      .from(conferences)
      .where(eq(conferences.id, conferenceId));
    if (!row) {
      return undefined;
    }
    const isSuperAdmin = row.superAdminAccount && user.mfa;
    if (row.status === 'deleted' && !isSuperAdmin) {
      return undefined;
    }
    return {
      conferenceId,
      status: row.status,
      isCreator: row.createdBy === user.id,
      isSuperAdmin,
      activeRoles: row.activeRoles,
      isTeamMember: row.isTeamMember,
      isAuthor: row.isAuthor,
    };
  }

  /** The user holds one of `roles` actively, or is a verified super admin. */
  static hasRole(
    access: ConferenceAccess,
    roles: readonly MemberRole[],
  ): boolean {
    return rules.hasRole(access, roles);
  }

  /** See rules.canViewConference. */
  static canViewConference(access: ConferenceAccess): boolean {
    return rules.canViewConference(access);
  }

  /** Throws 404 when the conference doesn't exist or the user may not see it at all. */
  async requireConference(
    user: AuthUser,
    conferenceId: string,
    executor?: Executor,
  ): Promise<ConferenceAccess> {
    const access = await this.conferenceAccess(user, conferenceId, executor);
    if (!access || !AccessService.canViewConference(access)) {
      // Not 403: don't confirm that a conference the user can't see exists.
      throw AppException.notFound('The conference');
    }
    return access;
  }

  /**
   * The user's standing on a paper; undefined when the paper doesn't exist or its conference is
   * deleted (unless the user is a super admin). Two queries: the paper, then its conference.
   */
  async submissionAccess(
    user: AuthUser,
    submissionId: string,
    executor: Executor = this.database.db,
  ): Promise<SubmissionAccess | undefined> {
    const [row] = await executor
      .select({
        conferenceId: submissions.conferenceId,
        status: submissions.status,
        outcome: submissions.outcome,
        notifiedOutcome: submissions.notifiedOutcome,
        submitterId: submissions.submitterId,
        reviewMode: conferences.reviewMode,
        isListedAuthor: sql<boolean>`exists (
          select 1 from ${submissionAuthors}
          where ${submissionAuthors.submissionId} = ${submissionId}
            and ${submissionAuthors.userId} = ${user.id})`,
        isClaimed: sql<boolean>`exists (
          select 1 from ${submissionAuthors}
          where ${submissionAuthors.submissionId} = ${submissionId}
            and ${submissionAuthors.userId} is not null)`,
        assignmentStatus: sql<
          SubmissionAccess['assignmentStatus']
        >`(select ${reviewAssignments.status}::text from ${reviewAssignments}
          where ${reviewAssignments.submissionId} = ${submissionId}
            and ${reviewAssignments.reviewerId} = ${user.id}
          limit 1)`,
      })
      .from(submissions)
      .innerJoin(conferences, eq(conferences.id, submissions.conferenceId))
      .where(eq(submissions.id, submissionId));
    if (!row) {
      return undefined;
    }
    const conference = await this.conferenceAccess(
      user,
      row.conferenceId,
      executor,
    );
    if (!conference) {
      return undefined;
    }
    return {
      submissionId,
      conference,
      reviewMode: row.reviewMode,
      status: row.status,
      outcome: row.outcome,
      notifiedOutcome: row.notifiedOutcome,
      isSubmitter: row.submitterId === user.id,
      isListedAuthor: row.isListedAuthor,
      isClaimed: row.isClaimed,
      assignmentStatus: row.assignmentStatus,
    };
  }

  /** The user's own review assignment on each of these papers (for lists; one query). */
  async assignmentStatuses(
    user: AuthUser,
    submissionIds: readonly string[],
    executor: Executor = this.database.db,
  ): Promise<Map<string, SubmissionAccess['assignmentStatus']>> {
    if (submissionIds.length === 0) {
      return new Map();
    }
    const rows = await executor
      .select({
        submissionId: reviewAssignments.submissionId,
        status: reviewAssignments.status,
      })
      .from(reviewAssignments)
      .where(
        and(
          eq(reviewAssignments.reviewerId, user.id),
          inArray(reviewAssignments.submissionId, [...submissionIds]),
        ),
      );
    return new Map(rows.map((r) => [r.submissionId, r.status]));
  }

  /** Throws 404 when the paper doesn't exist or the user may not see it (rules.canViewSubmission). */
  async requireSubmission(
    user: AuthUser,
    submissionId: string,
    executor?: Executor,
  ): Promise<SubmissionAccess> {
    const access = await this.submissionAccess(user, submissionId, executor);
    if (!access || !rules.canViewSubmission(access)) {
      throw AppException.notFound('The paper');
    }
    return access;
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
