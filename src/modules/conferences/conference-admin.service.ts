import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import { NotificationsService } from '../../core/notifications/notifications.service.js';
import { displayName, toConference } from './conference.mapper.js';
import { ConferencesRepository } from './conferences.repository.js';
import type {
  AdminConferenceResponse,
  ConferenceStatus,
  DeletionRequestResponse,
} from './dto/conference.dto.js';

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
    private readonly audit: AuditService,
  ) {}

  async list(status?: ConferenceStatus): Promise<AdminConferenceResponse[]> {
    const rows = await this.conferences.listAll(this.database.db, status);
    return rows.map((row) => ({
      ...toConference(row, { myRoles: [], isChair: true }),
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

  /** Approve: the conference goes live and gets its email templates. Decline: with a note. */
  async decide(
    admin: AuthUser,
    conferenceId: string,
    approve: boolean,
    note: string | null | undefined,
    client: ClientInfo,
  ): Promise<void> {
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
