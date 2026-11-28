import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Executor, Tx } from '../../core/database/database.types.js';
import {
  conferences,
  licenseRequests,
  profiles,
  users,
} from '../../core/database/schema/index.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import { NotificationsService } from '../../core/notifications/notifications.service.js';
import { canManageConference } from '../../core/rbac/access-rules.js';
import { AccessService } from '../../core/rbac/access.service.js';
import { ConferenceEmailsService } from './conference-emails.service.js';
import type {
  AdminLicenseRequestResponse,
  LicenseRequestResponse,
  LicenseStatus,
  RequestLicenseDto,
} from './dto/license.dto.js';

/** With no end date yet, a new conference's license runs this long from the day it was created. */
const TRIAL_DAYS = 30;

type RequestRow = typeof licenseRequests.$inferSelect;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The conference's license end: what a Super Admin set; otherwise one month after the
 * conference ends; with no end date yet, 30 days from its creation.
 */
export function licenseExpiryOf(conference: {
  details: unknown;
  createdAt: Date;
  endDate?: string | Date | null;
}): {
  expiry: string;
  onTrial: boolean;
} {
  const set = (conference.details as Record<string, unknown>).licenseExpiry;
  if (typeof set === 'string' && ISO_DAY.test(set)) {
    return { expiry: set, onTrial: false };
  }
  const end =
    conference.endDate instanceof Date
      ? day(conference.endDate)
      : (conference.endDate ?? '').slice(0, 10);
  return {
    expiry: ISO_DAY.test(end)
      ? addMonth(end)
      : addDays(day(conference.createdAt), TRIAL_DAYS),
    onTrial: true,
  };
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (isoDay: string, days: number) => {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return day(d);
};
/** One calendar month later; a day the next month lacks becomes its last day (31 Jan -> 28/29 Feb). */
export const addMonth = (isoDay: string) => {
  const [y, m, dd] = isoDay.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return day(new Date(Date.UTC(y, m, Math.min(dd, last))));
};

function toResponse(row: RequestRow): LicenseRequestResponse {
  return {
    id: row.id,
    requestedDate: row.requestedDate,
    reason: row.reason,
    status: row.status as LicenseStatus,
    decisionReason: row.decisionReason,
    newExpiry: row.newExpiry,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The license date of a conference and the requests to move it. */
@Injectable()
export class LicenseService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly emails: ConferenceEmailsService,
  ) {}

  private async requireChair(tx: Tx, user: AuthUser, conferenceId: string) {
    const access = await this.access.requireConference(user, conferenceId, tx);
    if (!canManageConference(access)) {
      throw AppException.forbidden(
        'Only a chair of this conference can do this.',
      );
    }
    return access;
  }

  private expiryOf(conference: {
    details: unknown;
    createdAt: Date;
    endDate?: string | null;
  }): string {
    return licenseExpiryOf(conference).expiry;
  }

  private async conference(executor: Executor, conferenceId: string) {
    const [row] = await executor
      .select({
        id: conferences.id,
        acronym: conferences.acronym,
        details: conferences.details,
        createdAt: conferences.createdAt,
        endDate: conferences.endDate,
        status: conferences.status,
      })
      .from(conferences)
      .where(eq(conferences.id, conferenceId));
    if (!row) {
      throw AppException.notFound('The conference');
    }
    return row;
  }

  /** The latest request of the conference (a chair), or null. */
  async latest(
    user: AuthUser,
    conferenceId: string,
  ): Promise<LicenseRequestResponse | null> {
    return this.database.transaction(async (tx) => {
      await this.requireChair(tx, user, conferenceId);
      const [row] = await tx
        .select()
        .from(licenseRequests)
        .where(eq(licenseRequests.conferenceId, conferenceId))
        .orderBy(desc(licenseRequests.createdAt))
        .limit(1);
      return row ? toResponse(row) : null;
    });
  }

  async request(
    user: AuthUser,
    conferenceId: string,
    dto: RequestLicenseDto,
    client: ClientInfo,
  ): Promise<LicenseRequestResponse> {
    return this.database.transaction(async (tx) => {
      const access = await this.requireChair(tx, user, conferenceId);
      if (
        access.status === 'rejected' ||
        access.status === 'deleted' ||
        access.status === 'cancelled'
      ) {
        throw AppException.businessRule(
          'This conference was declined or deleted.',
        );
      }
      const conference = await this.conference(tx, conferenceId);
      const today = day(new Date());
      const current = this.expiryOf(conference);
      const floor = current > today ? current : today;
      if (dto.requestedDate <= floor) {
        throw AppException.businessRule(`Pick a date after ${floor}.`);
      }
      const [open] = await tx
        .select({ id: licenseRequests.id })
        .from(licenseRequests)
        .where(
          and(
            eq(licenseRequests.conferenceId, conferenceId),
            eq(licenseRequests.status, 'pending'),
          ),
        );
      if (open) {
        throw AppException.conflict(
          'An extension request for this conference is already waiting for the Super Admin.',
        );
      }
      const [row] = await tx
        .insert(licenseRequests)
        .values({
          conferenceId,
          requestedBy: user.id,
          requestedDate: dto.requestedDate,
          reason: dto.reason ?? null,
        })
        .returning();
      await this.notifications.notifySuperAdmins(tx, {
        kind: 'license_request',
        title: `License extension requested: ${conference.acronym}`,
        body: `Until ${dto.requestedDate}${dto.reason ? ` — ${dto.reason}` : ''}`,
        conferenceId,
      });
      await this.emails.licenseRequested(
        tx,
        await this.emails.facts(tx, conferenceId),
        user.id,
        dto.requestedDate,
        dto.reason ?? null,
      );
      await this.audit.record(
        {
          action: 'conference.license_requested',
          actorId: user.id,
          entityType: 'conference',
          entityId: conferenceId,
          client,
          data: { requestedDate: dto.requestedDate },
        },
        tx,
      );
      return toResponse(row);
    });
  }

  async withdraw(
    user: AuthUser,
    conferenceId: string,
    client: ClientInfo,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      await this.requireChair(tx, user, conferenceId);
      const closed = await tx
        .update(licenseRequests)
        .set({ status: 'withdrawn', decidedAt: new Date() })
        .where(
          and(
            eq(licenseRequests.conferenceId, conferenceId),
            eq(licenseRequests.status, 'pending'),
          ),
        )
        .returning({ id: licenseRequests.id });
      if (closed.length === 0) {
        throw AppException.businessRule(
          'There is no open extension request for this conference.',
        );
      }
      await this.audit.record(
        {
          action: 'conference.license_withdrawn',
          actorId: user.id,
          entityType: 'conference',
          entityId: conferenceId,
          client,
        },
        tx,
      );
    });
  }

  // Super admins ---------------------------------------------------------------------------------

  /** "Extend license" on a conference's page: the license runs until `expiry`; its chairs are told. */
  async setExpiry(
    admin: AuthUser,
    conferenceId: string,
    expiry: string,
    client: ClientInfo,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      const conference = await this.conference(tx, conferenceId);
      if (
        conference.status === 'deleted' ||
        conference.status === 'rejected' ||
        conference.status === 'cancelled'
      ) {
        throw AppException.businessRule(
          'This conference was declined or deleted.',
        );
      }
      const current = this.expiryOf(conference);
      if (expiry <= day(new Date()) || expiry <= current) {
        throw AppException.businessRule(
          `Pick a date after ${current > day(new Date()) ? current : day(new Date())}.`,
        );
      }
      await tx
        .update(conferences)
        .set({
          details: sql`${conferences.details} || ${JSON.stringify({ licenseExpiry: expiry })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(conferences.id, conferenceId));
      await this.notifications.notifyChairs(tx, conferenceId, {
        kind: 'license_decision',
        title: `License extended to ${expiry}`,
        body: `Smartconferu extended the license of ${conference.acronym}.`,
      });
      await this.audit.record(
        {
          action: 'conference.license_extended',
          actorId: admin.id,
          entityType: 'conference',
          entityId: conferenceId,
          client,
          data: {
            acronym: conference.acronym,
            previous: current,
            newExpiry: expiry,
          },
        },
        tx,
      );
    });
  }

  async list(status: LicenseStatus): Promise<AdminLicenseRequestResponse[]> {
    const rows = await this.database.db
      .select({
        request: licenseRequests,
        slug: conferences.slug,
        acronym: conferences.acronym,
        title: conferences.title,
        details: conferences.details,
        confCreatedAt: conferences.createdAt,
        firstName: profiles.firstName,
        lastName: profiles.lastName,
        email: users.email,
      })
      .from(licenseRequests)
      .innerJoin(conferences, eq(conferences.id, licenseRequests.conferenceId))
      .innerJoin(users, eq(users.id, licenseRequests.requestedBy))
      .leftJoin(profiles, eq(profiles.id, users.id))
      .where(eq(licenseRequests.status, status))
      .orderBy(desc(licenseRequests.createdAt));
    return rows.map((r) => ({
      ...toResponse(r.request),
      conferenceId: r.request.conferenceId,
      conferenceSlug: r.slug,
      conferenceAcronym: r.acronym,
      conferenceTitle: r.title,
      currentExpiry:
        typeof (r.details as Record<string, unknown>).licenseExpiry === 'string'
          ? ((r.details as Record<string, unknown>).licenseExpiry as string)
          : null,
      requestedByName:
        [r.firstName, r.lastName].filter(Boolean).join(' ') ||
        r.email ||
        'Unknown',
      requestedByEmail: r.email,
    }));
  }

  /** Approve: the license runs until the date (default: the date asked for). Decline: with a reason. */
  async decide(
    admin: AuthUser,
    requestId: string,
    approve: boolean,
    newExpiry: string | undefined,
    reason: string | null | undefined,
    client: ClientInfo,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      const [request] = await tx
        .select()
        .from(licenseRequests)
        .where(eq(licenseRequests.id, requestId))
        .for('update');
      if (!request) {
        throw AppException.notFound('The extension request');
      }
      if (request.status !== 'pending') {
        throw AppException.businessRule(
          'This request is no longer waiting for an answer.',
        );
      }
      const conference = await this.conference(tx, request.conferenceId);
      const until = approve ? (newExpiry ?? request.requestedDate) : null;
      if (until && until <= day(new Date())) {
        throw AppException.businessRule('Choose a date in the future.');
      }
      await tx
        .update(licenseRequests)
        .set({
          status: approve ? 'approved' : 'declined',
          newExpiry: until,
          decisionReason: reason ?? null,
          decidedBy: admin.id,
          decidedAt: new Date(),
        })
        .where(eq(licenseRequests.id, requestId));
      if (until) {
        await tx
          .update(conferences)
          .set({
            details: sql`${conferences.details} || ${JSON.stringify({ licenseExpiry: until })}::jsonb`,
            updatedAt: new Date(),
          })
          .where(eq(conferences.id, request.conferenceId));
      }
      await this.notifications.notifyChairs(tx, request.conferenceId, {
        kind: 'license_decision',
        title: approve
          ? `License extended to ${until}`
          : 'License extension not approved',
        body: approve ? conference.acronym : (reason ?? conference.acronym),
      });
      await this.emails.licenseDecided(
        tx,
        await this.emails.facts(tx, request.conferenceId),
        approve,
        until,
        reason ?? null,
        admin.id,
      );
      await this.audit.record(
        {
          action: approve
            ? 'conference.license_extended'
            : 'conference.license_declined',
          actorId: admin.id,
          entityType: 'conference',
          entityId: request.conferenceId,
          client,
          data: until ? { newExpiry: until } : undefined,
        },
        tx,
      );
    });
  }
}
