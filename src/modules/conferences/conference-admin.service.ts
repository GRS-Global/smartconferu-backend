import { Injectable } from '@nestjs/common';
import { and, count, eq, inArray, ne } from 'drizzle-orm';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import {
  adminNotes,
  cfps,
  conferences,
  submissions,
} from '../../core/database/schema/index.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import { NotificationsService } from '../../core/notifications/notifications.service.js';
import { textToHtml } from '../../core/email/email-render.js';
import { displayName, toConference } from './conference.mapper.js';
import { ConferencesRepository } from './conferences.repository.js';
import { licenseExpiryOf } from './license.service.js';
import { ConferenceEmailsService } from './conference-emails.service.js';
import type { CfpStatus } from './dto/cfp.dto.js';
import type {
  AdminCfpResponse,
  AdminConferenceResponse,
  ConferenceStatus,
  DeletionRequestResponse,
} from './dto/conference.dto.js';

/** The email text a Super Admin typed in the decision popup. */
export interface DecisionEmailEdit {
  subject?: string;
  body?: string;
  saveAsDefault?: boolean;
}

/** The CFP page the chair chose (kept in the CFP's content as publicSlug). */
const pageText = (content: unknown): string | null => {
  const v = (content as Record<string, unknown> | null)?.publicSlug;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};

/** The license end and whether the conference is still on its first 30 days. */
const licenseOf = (row: {
  details: unknown;
  createdAt: Date;
  suspendedAt: Date | null;
}) => {
  const { expiry, onTrial } = licenseExpiryOf(row);
  return {
    licenseExpiry: expiry,
    onTrial,
    suspended: row.suspendedAt !== null,
  };
};

/**
 * The super admin's side of the conference lifecycle: approving requests, deciding deletion
 * requests, and bringing a deleted conference back. Routes are @SuperAdminOnly().
 */
@Injectable()
export class ConferenceAdminService {
  constructor(
    private readonly database: DatabaseService,
    private readonly conferences: ConferencesRepository,
    private readonly notifications: NotificationsService,
    private readonly emails: ConferenceEmailsService,
    private readonly audit: AuditService,
  ) {}

  /** Submitted papers (withdrawn ones included, drafts not) per conference. */
  private async paperCounts(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.database.db
      .select({ conferenceId: submissions.conferenceId, n: count() })
      .from(submissions)
      .where(
        and(
          inArray(submissions.conferenceId, ids),
          ne(submissions.status, 'draft'),
        ),
      )
      .groupBy(submissions.conferenceId);
    return new Map(rows.map((r) => [r.conferenceId, Number(r.n)]));
  }

  async list(status?: ConferenceStatus): Promise<AdminConferenceResponse[]> {
    const rows = await this.conferences.listAll(this.database.db, status);
    const papers = await this.paperCounts(rows.map((r) => r.id));
    return rows.map((row) => ({
      ...toConference(row, { myRoles: [], isChair: true }),
      papers: papers.get(row.id) ?? 0,
      ...licenseOf(row),
      requester: {
        id: row.createdBy,
        name: displayName(
          row.requesterFirstName,
          row.requesterLastName,
          row.requesterEmail ?? 'Unknown',
        ),
        email: row.requesterEmail,
        affiliation: row.requesterAffiliation,
      },
    }));
  }

  /**
   * Suspend: the conference becomes read-only for its chairs, team, authors and reviewers
   * (SuspensionGuard) until reactivated. Its chairs are told. Reactivate undoes it.
   */
  async setSuspended(
    admin: AuthUser,
    conferenceId: string,
    suspend: boolean,
    reason: string | null | undefined,
    client: ClientInfo,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      const [row] = await tx
        .select({
          acronym: conferences.acronym,
          status: conferences.status,
          suspendedAt: conferences.suspendedAt,
        })
        .from(conferences)
        .where(eq(conferences.id, conferenceId))
        .for('update');
      if (!row) {
        throw AppException.notFound('The conference');
      }
      if (row.status !== 'active' && row.status !== 'archived') {
        throw AppException.businessRule(
          'Only a live or archived conference can be suspended.',
        );
      }
      if ((row.suspendedAt !== null) === suspend) {
        return;
      }
      await tx
        .update(conferences)
        .set({
          suspendedAt: suspend ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(conferences.id, conferenceId));
      await this.notifications.notifyChairs(tx, conferenceId, {
        kind: 'conference_suspension',
        title: suspend
          ? `${row.acronym} is suspended`
          : `${row.acronym} is active again`,
        body: suspend
          ? (reason ??
            'Nothing can be changed in it for now. Contact Smartconferu support.')
          : 'Smartconferu lifted the suspension.',
      });
      await this.audit.record(
        {
          action: suspend ? 'conference.suspended' : 'conference.reactivated',
          actorId: admin.id,
          entityType: 'conference',
          entityId: conferenceId,
          client,
          data: { acronym: row.acronym, ...(reason ? { reason } : {}) },
        },
        tx,
      );
    });
  }

  /** "Ask for info" on a conference request: the chair who asked gets the message (notification and
   *  email), and it joins the request's thread in the console. The request stays waiting. */
  async askForInfo(
    admin: AuthUser,
    conferenceId: string,
    message: string,
    client: ClientInfo,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      const facts = await this.emails.facts(tx, conferenceId);
      const [row] = await tx
        .select({
          status: conferences.status,
          createdBy: conferences.createdBy,
        })
        .from(conferences)
        .where(eq(conferences.id, conferenceId));
      if (!row || row.status !== 'pending_approval') {
        throw AppException.businessRule(
          'This request is no longer waiting for a decision.',
        );
      }
      await tx.insert(adminNotes).values({
        queue: 'requests',
        itemId: conferenceId,
        kind: 'message',
        authorId: admin.id,
        text: message,
      });
      await this.notifications.notify(tx, [row.createdBy], {
        kind: 'conference_info_requested',
        title: `More information needed: ${facts.acronym}`,
        body: message,
        conferenceId,
      });
      await this.emails.infoRequested(
        tx,
        { ...facts, createdBy: row.createdBy },
        message,
        admin.id,
      );
      await this.audit.record(
        {
          action: 'conference.info_requested',
          actorId: admin.id,
          entityType: 'conference',
          entityId: conferenceId,
          client,
          data: { acronym: facts.acronym },
        },
        tx,
      );
    });
  }

  /** The Calls for Papers waiting for approval (or in another state), newest conference first. */
  async listCfps(cfpState: CfpStatus): Promise<AdminCfpResponse[]> {
    const rows = await this.conferences.listAll(
      this.database.db,
      undefined,
      cfpState,
    );
    const ids = rows.map((r) => r.id);
    const [papers, pages] = await Promise.all([
      this.paperCounts(ids),
      ids.length
        ? this.database.db
            .select({
              conferenceId: cfps.conferenceId,
              content: cfps.content,
              submittedAt: cfps.submittedAt,
            })
            .from(cfps)
            .where(inArray(cfps.conferenceId, ids))
        : Promise.resolve([]),
    ]);
    const pageOf = new Map(pages.map((p) => [p.conferenceId, p]));
    return rows.map((row) => ({
      cfpPage: pageText(pageOf.get(row.id)?.content),
      cfpSubmittedAt: pageOf.get(row.id)?.submittedAt?.toISOString() ?? null,
      ...toConference(row, { myRoles: [], isChair: true }),
      papers: papers.get(row.id) ?? 0,
      ...licenseOf(row),
      requester: {
        id: row.createdBy,
        name: displayName(
          row.requesterFirstName,
          row.requesterLastName,
          row.requesterEmail ?? 'Unknown',
        ),
        email: row.requesterEmail,
        affiliation: row.requesterAffiliation,
      },
    }));
  }

  /** Approve: the Call for Papers goes live and the submission link opens. Decline: back to the chairs with a note. */
  async decideCfp(
    admin: AuthUser,
    conferenceId: string,
    approve: boolean,
    note: string | null | undefined,
    client: ClientInfo,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      const now = new Date();
      const moved = await this.conferences.decideCfp(tx, conferenceId, {
        status: approve ? 'published' : 'rejected',
        decidedAt: now,
        adminNote: approve ? null : (note ?? null),
      });
      if (!moved) {
        const exists = await this.conferences.findById(tx, conferenceId);
        if (!exists) throw AppException.notFound('The conference');
        throw AppException.businessRule(
          'This Call for Papers is not waiting for approval (it was already decided, or was never sent).',
        );
      }
      const conference = await this.conferences.findById(tx, conferenceId);
      await this.notifications.notifyChairs(tx, conferenceId, {
        // Its own kind, so the bell can open the Call for Papers page.
        kind: 'cfp_decision',
        title: approve
          ? 'Call for Papers approved'
          : 'Call for Papers not approved',
        body: approve ? conference!.acronym : (note ?? conference!.acronym),
      });
      await this.emails.cfpDecided(
        tx,
        conference!,
        approve,
        note ?? null,
        admin.id,
      );
      await this.audit.record(
        {
          action: approve ? 'cfp.approved' : 'cfp.declined',
          actorId: admin.id,
          entityType: 'conference',
          entityId: conferenceId,
          client,
          data: note ? { note } : undefined,
        },
        tx,
      );
    });
  }

  /** Approve: the conference goes live and gets its email templates. Decline: with a note. */
  async decide(
    admin: AuthUser,
    conferenceId: string,
    approve: boolean,
    note: string | null | undefined,
    client: ClientInfo,
    email?: DecisionEmailEdit,
  ): Promise<void> {
    const override = this.decisionOverride(approve, email);
    await this.database.transaction(async (tx) => {
      const moved = await this.conferences.moveStatus(
        tx,
        conferenceId,
        'pending_approval',
        { status: approve ? 'active' : 'rejected', adminNote: note ?? null },
      );
      if (!moved) {
        const exists = await this.conferences.findById(tx, conferenceId);
        if (!exists) throw AppException.notFound('The conference');
        throw AppException.businessRule(
          'This conference request has already been decided.',
        );
      }
      const conference = await this.conferences.findById(tx, conferenceId);
      if (approve) {
        await this.conferences.copyEmailTemplates(tx, conferenceId);
      }
      await this.notifications.notify(tx, [conference!.createdBy], {
        kind: 'conference_decision',
        title: approve ? 'Conference approved' : 'Conference request declined',
        body: note ?? conference!.acronym,
        conferenceId,
      });
      if (override && email?.saveAsDefault) {
        await this.emails.saveDecisionDefault(tx, approve, override, admin.id);
      }
      await this.emails.decided(tx, conference!, approve, admin.id, override);
      await this.audit.record(
        {
          action: approve ? 'conference.approved' : 'conference.declined',
          actorId: admin.id,
          entityType: 'conference',
          entityId: conferenceId,
          client,
          data: note ? { note } : undefined,
        },
        tx,
      );
    });
  }

  /** What the decision popup shows: both emails as plain text, and the logo they carry. */
  decisionEmails() {
    return this.emails.decisionDefaults(this.database.db);
  }

  /** The popup's edited text (plain) as the email's own: HTML body; an approval must keep the link to the conference. */
  private decisionOverride(
    approve: boolean,
    email?: DecisionEmailEdit,
  ): { subject?: string; body?: string } | undefined {
    const subject = email?.subject?.trim() || undefined;
    const text = email?.body?.trim() || undefined;
    if (!subject && !text) {
      return undefined;
    }
    if (approve && text && !text.includes('{{dashboard_link}}')) {
      throw AppException.validation(
        'The email must keep the conference link.',
        [
          {
            field: 'emailBody',
            errors: [
              'must contain {{dashboard_link}} so the chair can open the conference',
            ],
          },
        ],
      );
    }
    return { subject, body: text ? textToHtml(text) : undefined };
  }

  async listDeletionRequests(
    status?: string,
  ): Promise<DeletionRequestResponse[]> {
    const rows = await this.conferences.listDeletionRequests(
      this.database.db,
      status,
    );
    return rows.map((row) => ({
      id: row.id,
      conferenceId: row.conferenceId,
      acronym: row.acronym,
      title: row.title,
      status: row.status,
      reason: row.reason,
      adminNote: row.adminNote,
      requestedBy: {
        id: row.requestedBy,
        name: displayName(
          row.requesterFirstName,
          row.requesterLastName,
          row.requesterEmail ?? 'Unknown',
        ),
        email: row.requesterEmail,
      },
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
    }));
  }

  /** Approving marks the archived conference deleted: it disappears from every list. */
  async decideDeletion(
    admin: AuthUser,
    requestId: string,
    approve: boolean,
    note: string | null | undefined,
    client: ClientInfo,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      const request = await this.conferences.closePendingDeletionRequest(
        tx,
        { id: requestId },
        {
          status: approve ? 'approved' : 'rejected',
          adminNote: note ?? null,
          decidedBy: admin.id,
        },
      );
      if (!request) {
        throw AppException.businessRule(
          'This request has already been decided or was taken back.',
        );
      }
      const conference = await this.conferences.findById(
        tx,
        request.conferenceId,
      );
      if (approve) {
        const deleted = await this.conferences.moveStatus(
          tx,
          request.conferenceId,
          'archived',
          { status: 'deleted', deletedAt: new Date() },
        );
        if (!deleted) {
          throw AppException.businessRule(
            'Only an archived conference can be deleted.',
          );
        }
      }
      await this.notifications.notify(tx, [request.requestedBy], {
        kind: 'conference_decision',
        title: approve
          ? `${conference!.acronym} was deleted`
          : `Deletion of ${conference!.acronym} was not approved`,
        body: approve
          ? 'The Super Admin approved your request. The conference no longer appears in any list.'
          : (note ?? 'The conference stays archived.'),
        // A deleted conference's notifications shouldn't link back to it.
        conferenceId: approve ? null : request.conferenceId,
      });
      await this.emails.deletionDecided(
        tx,
        conference!,
        request.requestedBy,
        approve,
        note ?? null,
        admin.id,
      );
      await this.audit.record(
        {
          action: approve
            ? 'conference.deleted'
            : 'conference.deletion_rejected',
          actorId: admin.id,
          entityType: 'conference',
          entityId: request.conferenceId,
          client,
          data: note ? { note } : undefined,
        },
        tx,
      );
    });
  }

  /** Deleted → archived; its chairs can restore it from there. */
  async restoreDeleted(
    admin: AuthUser,
    conferenceId: string,
    client: ClientInfo,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      const moved = await this.conferences.moveStatus(
        tx,
        conferenceId,
        'deleted',
        { status: 'archived', deletedAt: null },
      );
      if (!moved) {
        throw AppException.businessRule('This conference is not deleted.');
      }
      const conference = await this.conferences.findById(tx, conferenceId);
      const asker =
        (await this.conferences.lastApprovedDeletionRequester(
          tx,
          conferenceId,
        )) ?? conference!.createdBy;
      await this.notifications.notify(tx, [asker], {
        kind: 'conference_decision',
        title: `${conference!.acronym} is back`,
        body: 'The Super Admin brought the conference back. It is archived: restore it from Conference Settings when you want it open again.',
        conferenceId,
      });
      await this.emails.restored(tx, conference!, asker, admin.id);
      await this.audit.record(
        {
          action: 'conference.undeleted',
          actorId: admin.id,
          entityType: 'conference',
          entityId: conferenceId,
          client,
        },
        tx,
      );
    });
  }
}
