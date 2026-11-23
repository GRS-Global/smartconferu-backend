import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Executor } from '../../core/database/database.types.js';
import {
  profileDetails,
  profiles,
  profileVerifications,
  users,
} from '../../core/database/schema/index.js';
import {
  EmailQueueService,
  type WrittenEmail,
} from '../../core/email/email-queue.service.js';
import { EmailRecipientsService } from '../../core/email/email-recipients.service.js';
import { escapeHtml, firstName } from '../../core/email/email-render.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import { NotificationsService } from '../../core/notifications/notifications.service.js';
import type {
  MyVerificationResponse,
  RejectVerificationDto,
  RequestVerificationDto,
  VerificationResponse,
} from './dto/profile-verification.dto.js';

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/**
 * "Verify my profile": the member asks, the Super Admin approves (green tick on the profile) or
 * rejects with a reason. The member is emailed either way.
 */
@Injectable()
export class ProfileVerificationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly emailQueue: EmailQueueService,
    private readonly recipients: EmailRecipientsService,
  ) {}

  /** Where the member's own request stands. An approval stays; otherwise the latest request counts. */
  mine(user: AuthUser): Promise<MyVerificationResponse> {
    return this.statusOf(this.database.db, user.id);
  }

  async statusOf(
    executor: Executor,
    userId: string,
  ): Promise<MyVerificationResponse> {
    const rows = await executor
      .select()
      .from(profileVerifications)
      .where(
        and(
          eq(profileVerifications.userId, userId),
          inArray(profileVerifications.status, [
            'pending',
            'approved',
            'rejected',
          ]),
        ),
      )
      .orderBy(desc(profileVerifications.createdAt));
    const row = rows.find((r) => r.status === 'approved') ?? rows[0];
    if (!row) {
      return {
        status: 'none',
        requestedAt: null,
        resolvedAt: null,
        reason: null,
      };
    }
    return {
      status:
        row.status === 'approved'
          ? 'verified'
          : (row.status as 'pending' | 'rejected'),
      requestedAt: row.createdAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      reason: row.status === 'rejected' ? row.reason : null,
    };
  }

  async request(
    user: AuthUser,
    dto: RequestVerificationDto,
    client: ClientInfo,
  ): Promise<MyVerificationResponse> {
    await this.database.transaction(async (tx) => {
      const current = await this.statusOf(tx, user.id);
      if (current.status === 'verified') {
        throw AppException.conflict('Your profile is already verified.');
      }
      if (current.status === 'pending') {
        throw AppException.conflict(
          'Your verification request is already waiting for review.',
        );
      }
      const [profile] = await tx
        .select({
          firstName: profiles.firstName,
          lastName: profiles.lastName,
          designation: profiles.designation,
          affiliation: profiles.affiliation,
        })
        .from(profiles)
        .where(eq(profiles.id, user.id));
      if (
        !profile?.firstName ||
        !profile.lastName ||
        !profile.affiliation ||
        !profile.designation
      ) {
        throw AppException.businessRule(
          'Add your name, designation and affiliation to your profile first, so there is something to verify.',
        );
      }
      const [row] = await tx
        .insert(profileVerifications)
        .values({ userId: user.id, note: dto.note?.trim() || null })
        .returning({ id: profileVerifications.id });
      await this.notifications.notifySuperAdmins(tx, {
        kind: 'profile_verification_request',
        title: `Profile verification: ${profile.firstName} ${profile.lastName}`,
        body: 'A member asked for their profile to be verified.',
        link: '/super-admin/profile-verification',
      });
      await this.audit.record(
        {
          action: 'profile.verification_requested',
          actorId: user.id,
          entityType: 'profile_verification',
          entityId: row.id,
          client,
          data: {},
        },
        tx,
      );
    });
    return this.mine(user);
  }

  async withdraw(user: AuthUser): Promise<MyVerificationResponse> {
    await this.database.db
      .update(profileVerifications)
      .set({ status: 'withdrawn', resolvedAt: new Date() })
      .where(
        and(
          eq(profileVerifications.userId, user.id),
          eq(profileVerifications.status, 'pending'),
        ),
      );
    return this.mine(user);
  }

  // Super Admin -----------------------------------------------------------------------------------

  async list(status: 'pending' | 'resolved'): Promise<VerificationResponse[]> {
    const rows = await this.database.db
      .select({
        v: profileVerifications,
        firstName: profiles.firstName,
        lastName: profiles.lastName,
        designation: profiles.designation,
        affiliation: profiles.affiliation,
        country: profiles.country,
        orcidId: profiles.orcidId,
        email: users.email,
        emailVerifiedAt: users.emailVerifiedAt,
        details: profileDetails.data,
      })
      .from(profileVerifications)
      .innerJoin(users, eq(users.id, profileVerifications.userId))
      .leftJoin(profiles, eq(profiles.id, profileVerifications.userId))
      .leftJoin(
        profileDetails,
        eq(profileDetails.userId, profileVerifications.userId),
      )
      .where(
        status === 'pending'
          ? eq(profileVerifications.status, 'pending')
          : inArray(profileVerifications.status, ['approved', 'rejected']),
      )
      .orderBy(
        status === 'pending'
          ? asc(profileVerifications.createdAt)
          : desc(profileVerifications.resolvedAt),
      );
    return rows.map((r) => {
      const details = record(r.details);
      const pro = record(record(details.emails).professional);
      return {
        id: r.v.id,
        status: r.v.status as VerificationResponse['status'],
        note: r.v.note,
        reason: r.v.reason,
        createdAt: r.v.createdAt.toISOString(),
        resolvedAt: r.v.resolvedAt?.toISOString() ?? null,
        person: {
          id: r.v.userId,
          name:
            [r.firstName, r.lastName].filter(Boolean).join(' ') ||
            r.email ||
            'A member',
          email: r.email,
          emailVerified: r.emailVerifiedAt != null,
          designation: r.designation,
          affiliation: r.affiliation,
          country: r.country,
          orcidId: r.orcidId,
          institutionalEmail: text(pro.value) || null,
          institutionalEmailVerified:
            pro.status === 'verified' && Boolean(text(pro.value)),
          webPage: text(details.webPage) || null,
        },
      };
    });
  }

  approve(admin: AuthUser, id: string, client: ClientInfo): Promise<void> {
    return this.decide(admin, id, client, { approved: true });
  }

  reject(
    admin: AuthUser,
    id: string,
    dto: RejectVerificationDto,
    client: ClientInfo,
  ): Promise<void> {
    return this.decide(admin, id, client, {
      approved: false,
      reason: dto.reason,
    });
  }

  private async decide(
    admin: AuthUser,
    id: string,
    client: ClientInfo,
    outcome: { approved: true } | { approved: false; reason: string },
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(profileVerifications)
        .where(eq(profileVerifications.id, id))
        .for('update');
      if (!row) throw AppException.notFound('That request');
      if (row.status !== 'pending') {
        throw AppException.conflict(
          'This request was already answered (or withdrawn).',
        );
      }
      await tx
        .update(profileVerifications)
        .set({
          status: outcome.approved ? 'approved' : 'rejected',
          reason: outcome.approved ? null : outcome.reason,
          resolvedBy: admin.id,
          resolvedAt: new Date(),
        })
        .where(eq(profileVerifications.id, id));

      await this.notifications.notify(
        tx,
        [row.userId],
        outcome.approved
          ? {
              kind: 'profile_verification_approved',
              title: 'Your profile is verified',
              body: 'The green tick now shows on your profile.',
              link: '/profile',
            }
          : {
              kind: 'profile_verification_rejected',
              title: 'Your profile could not be verified',
              body: outcome.reason,
              link: '/profile',
            },
      );

      const people = await this.recipients.people(tx, [row.userId]);
      const profileLink = this.recipients.link('/profile');
      const link = `<p><a href="${escapeHtml(profileLink)}" style="color:#4F46E5">${escapeHtml(profileLink)}</a></p>`;
      const emails = [...people.values()].map((person): WrittenEmail => {
        const hi = `<p>Hi ${escapeHtml(firstName(person.name, person.email))},</p>`;
        return {
          key: outcome.approved
            ? 'profileVerificationApproved'
            : 'profileVerificationRejected',
          label: outcome.approved ? 'Profile verified' : 'Profile not verified',
          recipientType: 'Member',
          to: person,
          subject: outcome.approved
            ? 'Your profile is verified'
            : 'Your profile could not be verified',
          body: outcome.approved
            ? `${hi}<p>Good news: our team verified your Smartconferu profile. The green tick now shows next to your name.</p>${link}`
            : `${hi}<p>We could not verify your profile this time:</p><p>“${escapeHtml(outcome.reason)}”</p><p>You can update your profile and ask again.</p>${link}`,
        };
      });
      await this.emailQueue.enqueue(
        tx,
        outcome.approved
          ? 'profile_verification_approved'
          : 'profile_verification_rejected',
        emails,
        { sentBy: admin.id },
      );
      await this.audit.record(
        {
          action: outcome.approved
            ? 'admin.profile_verification_approved'
            : 'admin.profile_verification_rejected',
          actorId: admin.id,
          entityType: 'profile_verification',
          entityId: id,
          client,
          data: {
            userId: row.userId,
            ...(outcome.approved ? {} : { reason: outcome.reason }),
          },
        },
        tx,
      );
    });
  }
}
