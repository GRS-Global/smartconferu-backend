import { HttpStatus, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { AuditService } from '../../core/audit/audit.service.js';
import { AccessTokenService } from '../../core/auth/access-token.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Executor } from '../../core/database/database.types.js';
import {
  authTokens,
  conferenceDeletionRequests,
  conferenceMembers,
  conferences,
  decisionEvents,
  licenseRequests,
  mfaRecoveryCodes,
  notifications,
  pendingReviewAssignments,
  profileDetails,
  profiles,
  reviewAssignments,
  reviewExtensionRequests,
  reviews,
  sessions,
  submissionAuthors,
  submissionFiles,
  submissions,
  trustedDevices,
  userIdentities,
  userMfa,
  users,
} from '../../core/database/schema/index.js';
import { EmailService } from '../../core/email/email.service.js';
import { renderEmail } from '../../core/email/layout.js';
import { AppException, ErrorCode } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import type { AdminSessionResponse } from './dto/admin.dto.js';

/** How long a "View as" support view lasts. */
export const SUPPORT_VIEW_MINUTES = 30;

const nameOf = (
  first: string | null,
  last: string | null,
  email: string | null,
) => [first, last].filter(Boolean).join(' ') || email || 'this account';

/**
 * Support actions on one account (the user's page in the console): where they are signed in (and
 * signing them out of one device), resetting two-step verification, merging two accounts.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly tokens: AccessTokenService,
  ) {}

  private async user(executor: Executor, id: string) {
    const [row] = await executor
      .select({
        id: users.id,
        email: users.email,
        status: users.status,
        isSuperAdmin: users.isSuperAdmin,
        firstName: profiles.firstName,
        lastName: profiles.lastName,
      })
      .from(users)
      .leftJoin(profiles, eq(profiles.id, users.id))
      .where(eq(users.id, id));
    if (!row) {
      throw AppException.notFound('User');
    }
    return { ...row, name: nameOf(row.firstName, row.lastName, row.email) };
  }

  /** "Signed-in devices": one entry per sign-in that can still be used, newest first. */
  async sessions(id: string): Promise<AdminSessionResponse[]> {
    await this.user(this.database.db, id);
    const rows = await this.database.db
      .select({
        id: sessions.familyId,
        signedInAt: sql<Date>`min(${sessions.createdAt})`.mapWith(
          sessions.createdAt,
        ),
        lastActiveAt: sql<Date>`max(${sessions.createdAt})`.mapWith(
          sessions.createdAt,
        ),
        userAgent: sql<
          string | null
        >`(array_agg(${sessions.userAgent} order by ${sessions.createdAt} desc))[1]`,
        ipAddress: sql<
          string | null
        >`(array_agg(${sessions.ipAddress} order by ${sessions.createdAt} desc))[1]`,
      })
      .from(sessions)
      .where(eq(sessions.userId, id))
      .groupBy(sessions.familyId)
      .having(
        sql`bool_or(${sessions.revokedAt} is null and ${sessions.rotatedAt} is null and ${sessions.expiresAt} > now())
            and bool_and(${sessions.revokedAt} is null)`,
      )
      .orderBy(desc(sql`max(${sessions.createdAt})`));
    return rows.map((r) => ({
      id: r.id,
      signedInAt: r.signedInAt.toISOString(),
      lastActiveAt: r.lastActiveAt.toISOString(),
      userAgent: r.userAgent,
      ipAddress: r.ipAddress,
    }));
  }

  /** "Sign out" one of the user's devices. */
  async revokeSession(
    admin: AuthUser,
    id: string,
    familyId: string,
    client: ClientInfo,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      const target = await this.user(tx, id);
      const ended = await tx
        .update(sessions)
        .set({ revokedAt: new Date(), revokedReason: 'signed_out_by_admin' })
        .where(
          and(
            eq(sessions.userId, id),
            eq(sessions.familyId, familyId),
            isNull(sessions.revokedAt),
          ),
        )
        .returning({ id: sessions.id });
      if (ended.length === 0) {
        throw AppException.notFound('That sign-in');
      }
      await this.audit.record(
        {
          action: 'admin.user_signed_out',
          actorId: admin.id,
          entityType: 'user',
          entityId: id,
          client,
          data: { name: target.name, session: familyId },
        },
        tx,
      );
    });
  }

  /**
   * "View as": a read-only token for the user app as this person, for SUPPORT_VIEW_MINUTES, with the
   * reason in the activity log. Not for super admins or suspended accounts.
   */
  async viewAs(
    admin: AuthUser,
    id: string,
    reason: string,
    client: ClientInfo,
  ): Promise<{
    accessToken: string;
    expiresAt: string;
    user: { id: string; name: string; email: string | null };
  }> {
    const target = await this.user(this.database.db, id);
    if (target.isSuperAdmin) {
      throw AppException.businessRule(
        "A super admin's account can't be viewed as.",
      );
    }
    if (target.status !== 'active') {
      throw AppException.businessRule('This account is suspended or closed.');
    }
    const accessToken = await this.tokens.issueSupportView(
      id,
      admin.id,
      SUPPORT_VIEW_MINUTES,
    );
    await this.audit.record({
      action: 'admin.user_viewed_as',
      actorId: admin.id,
      entityType: 'user',
      entityId: id,
      client,
      data: { name: target.name, reason, minutes: SUPPORT_VIEW_MINUTES },
    });
    return {
      accessToken,
      expiresAt: new Date(
        Date.now() + SUPPORT_VIEW_MINUTES * 60_000,
      ).toISOString(),
      user: { id, name: target.name, email: target.email },
    };
  }

  /**
   * "Reset 2-step": the authenticator app and recovery codes are removed and every trusted device
   * forgotten, so the user sets two-step verification up again. They are emailed.
   */
  async resetMfa(
    admin: AuthUser,
    id: string,
    client: ClientInfo,
  ): Promise<void> {
    const target = await this.database.transaction(async (tx) => {
      const user = await this.user(tx, id);
      if (user.id === admin.id) {
        throw AppException.businessRule(
          'Reset your own two-step verification from your account settings.',
        );
      }
      await tx.delete(userMfa).where(eq(userMfa.userId, id));
      await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, id));
      await tx
        .update(trustedDevices)
        .set({ revokedAt: new Date() })
        .where(
          and(eq(trustedDevices.userId, id), isNull(trustedDevices.revokedAt)),
        );
      await this.audit.record(
        {
          action: 'admin.user_mfa_reset',
          actorId: admin.id,
          entityType: 'user',
          entityId: id,
          client,
          data: { name: user.name },
        },
        tx,
      );
      return user;
    });
    if (target.email) {
      await this.email.sendQuietly(
        renderEmail({
          to: target.email,
          subject: 'Your two-step verification was reset',
          heading: 'Two-step verification was reset',
          paragraphs: [
            'The Smartconferu team reset two-step verification on your account, as asked.',
            'The next time you sign in, set it up again with your authenticator app.',
            "If you didn't ask for this, reply to this email straight away.",
          ],
        }),
      );
    }
  }

  /**
   * "Merge accounts": everything of `otherId` (papers, reviews, conference roles, requests,
   * notifications, sign-in providers) moves to `keepId`. The other account is closed (kept,
   * disabled and without an email, so the activity log still says who did what) and its address
   * is remembered on the kept profile. Both addresses are emailed.
   */
  async merge(
    admin: AuthUser,
    keepId: string,
    otherId: string,
    client: ClientInfo,
  ): Promise<void> {
    if (keepId === otherId) {
      throw AppException.businessRule('Choose two different accounts.');
    }
    const { keep, other } = await this.database.transaction(async (tx) => {
      const keep = await this.user(tx, keepId);
      const other = await this.user(tx, otherId);
      if (other.isSuperAdmin) {
        throw AppException.businessRule(
          "A super admin's account can't be merged into another one.",
        );
      }
      // Both review the same paper: the reviews can't be combined.
      const [clash] = await tx
        .select({ id: reviewAssignments.id })
        .from(reviewAssignments)
        .where(
          and(
            eq(reviewAssignments.reviewerId, otherId),
            inArray(
              reviewAssignments.submissionId,
              tx
                .select({ id: reviewAssignments.submissionId })
                .from(reviewAssignments)
                .where(eq(reviewAssignments.reviewerId, keepId)),
            ),
          ),
        )
        .limit(1);
      if (clash) {
        throw new AppException(
          HttpStatus.CONFLICT,
          ErrorCode.CONFLICT,
          'Both accounts review the same paper, so they can’t be merged. Remove one of the two assignments first.',
        );
      }

      // Conference roles: drop the other's duplicates, move the rest.
      await tx.delete(conferenceMembers).where(
        and(
          eq(conferenceMembers.userId, otherId),
          sql`exists (select 1 from ${conferenceMembers} k where k.user_id = ${keepId}
                and k.conference_id = ${conferenceMembers.conferenceId} and k.role = ${conferenceMembers.role})`,
        ),
      );
      await tx
        .update(conferenceMembers)
        .set({ userId: keepId })
        .where(eq(conferenceMembers.userId, otherId));
      await tx
        .update(conferenceMembers)
        .set({ invitedBy: keepId })
        .where(eq(conferenceMembers.invitedBy, otherId));

      // Everything else points at the kept account.
      await tx
        .update(submissions)
        .set({ submitterId: keepId })
        .where(eq(submissions.submitterId, otherId));
      await tx
        .update(submissions)
        .set({ decidedBy: keepId })
        .where(eq(submissions.decidedBy, otherId));
      await tx
        .update(submissionAuthors)
        .set({ userId: keepId })
        .where(eq(submissionAuthors.userId, otherId));
      await tx
        .update(submissionFiles)
        .set({ uploadedBy: keepId })
        .where(eq(submissionFiles.uploadedBy, otherId));
      await tx
        .update(reviewAssignments)
        .set({ reviewerId: keepId })
        .where(eq(reviewAssignments.reviewerId, otherId));
      await tx
        .update(reviewAssignments)
        .set({ assignedBy: keepId })
        .where(eq(reviewAssignments.assignedBy, otherId));
      await tx
        .update(reviews)
        .set({ reviewerId: keepId })
        .where(eq(reviews.reviewerId, otherId));
      await tx
        .update(pendingReviewAssignments)
        .set({ assignedBy: keepId })
        .where(eq(pendingReviewAssignments.assignedBy, otherId));
      await tx
        .update(reviewExtensionRequests)
        .set({ decidedBy: keepId })
        .where(eq(reviewExtensionRequests.decidedBy, otherId));
      await tx
        .update(decisionEvents)
        .set({ decidedBy: keepId })
        .where(eq(decisionEvents.decidedBy, otherId));
      await tx
        .update(conferences)
        .set({ createdBy: keepId })
        .where(eq(conferences.createdBy, otherId));
      await tx
        .update(conferenceDeletionRequests)
        .set({ requestedBy: keepId })
        .where(eq(conferenceDeletionRequests.requestedBy, otherId));
      await tx
        .update(licenseRequests)
        .set({ requestedBy: keepId })
        .where(eq(licenseRequests.requestedBy, otherId));
      await tx
        .update(notifications)
        .set({ userId: keepId })
        .where(eq(notifications.userId, otherId));
      await tx
        .update(userIdentities)
        .set({ userId: keepId })
        .where(eq(userIdentities.userId, otherId));

      // The other account is closed: no sign-in, no email, every session and token gone.
      await tx
        .update(users)
        .set({ status: 'disabled', email: null, passwordHash: null })
        .where(eq(users.id, otherId));
      await tx
        .update(sessions)
        .set({ revokedAt: new Date(), revokedReason: 'merged' })
        .where(and(eq(sessions.userId, otherId), isNull(sessions.revokedAt)));
      await tx.delete(authTokens).where(eq(authTokens.userId, otherId));
      await tx.delete(trustedDevices).where(eq(trustedDevices.userId, otherId));
      await tx.delete(userMfa).where(eq(userMfa.userId, otherId));

      // Its address is remembered on the kept profile (a secondary email).
      if (other.email) {
        await tx
          .insert(profileDetails)
          .values({ userId: keepId, data: { mergedEmails: [other.email] } })
          .onConflictDoUpdate({
            target: profileDetails.userId,
            set: {
              data: sql`${profileDetails.data} || jsonb_build_object('mergedEmails',
                coalesce(${profileDetails.data}->'mergedEmails', '[]'::jsonb) || ${JSON.stringify([other.email])}::jsonb)`,
            },
          });
      }
      await this.audit.record(
        {
          action: 'admin.users_merged',
          actorId: admin.id,
          entityType: 'user',
          entityId: keepId,
          client,
          data: {
            name: keep.name,
            mergedUserId: otherId,
            mergedEmail: other.email,
          },
        },
        tx,
      );
      return { keep, other };
    });

    for (const to of [keep.email, other.email]) {
      if (to) {
        await this.email.sendQuietly(
          renderEmail({
            to,
            subject: 'Your Smartconferu accounts were merged',
            heading: 'Your accounts were merged',
            paragraphs: [
              `The Smartconferu team merged the account ${other.email ?? 'without an email'} into ${keep.email ?? 'your main account'}, as asked.`,
              `Papers, reviews and conference roles are now all on ${keep.email ?? 'the main account'}. Sign in with that address from now on.`,
              "If you didn't ask for this, reply to this email straight away.",
            ],
          }),
        );
      }
    }
  }
}
