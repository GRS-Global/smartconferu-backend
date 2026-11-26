import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Tx } from '../../core/database/database.types.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import { NotificationsService } from '../../core/notifications/notifications.service.js';
import {
  canManageConference,
  isChair as isChairOf,
} from '../../core/rbac/access-rules.js';
import {
  AccessService,
  CHAIR_ROLES,
  type ConferenceAccess,
} from '../../core/rbac/access.service.js';
import { ConferenceEmailsService } from './conference-emails.service.js';
import { toConference, toPublicConference } from './conference.mapper.js';
import {
  type ConferenceInsert,
  ConferencesRepository,
  type ConferenceWithCfp,
} from './conferences.repository.js';
import type {
  ArchivedConferenceNotice,
  ConferenceResponse,
  CreateConferenceDto,
  MyConferencesResponse,
  PublicConferenceResponse,
  SubmissionFormResponse,
  UpdateConferenceDto,
} from './dto/conference.dto.js';
import type { DirectoryEntryResponse } from './dto/cfp.dto.js';

/** "ISBM 2027-28" → "isbm202728": the URL id of a conference. */
export function slugFromAcronym(acronym: string): string {
  return acronym
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 40);
}

const MAX_SLUG_SUFFIX = 50;

/**
 * Conferences: a chair asks for one, a super admin approves it (ConferenceAdminService), and its
 * chairs run it — details, settings, archiving, and asking for it to be deleted.
 */
@Injectable()
export class ConferencesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly conferences: ConferencesRepository,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
    private readonly emails: ConferenceEmailsService,
    private readonly audit: AuditService,
  ) {}

  /** Anyone signed in may ask for a conference; it starts waiting for a super admin. */
  async create(
    user: AuthUser,
    dto: CreateConferenceDto,
    client: ClientInfo,
  ): Promise<ConferenceResponse> {
    this.assertDateOrder(dto.startDate, dto.endDate);
    const id = await this.database.transaction(async (tx) => {
      const slug = await this.freeSlug(tx, dto.acronym);
      const conference = await this.conferences.create(tx, {
        slug,
        acronym: dto.acronym,
        title: dto.title,
        about: dto.about ?? null,
        mode: dto.mode ?? null,
        venue: dto.venue ?? null,
        city: dto.city ?? null,
        state: dto.state ?? null,
        country: dto.country ?? null,
        webPage: dto.webPage ?? null,
        contactEmail: dto.contactEmail ?? null,
        primaryArea: dto.primaryArea ?? null,
        secondaryArea: dto.secondaryArea ?? null,
        startDate: dto.startDate ?? null,
        endDate: dto.endDate ?? null,
        details: dto.details ?? {},
        createdBy: user.id,
      });
      await this.notifications.notifySuperAdmins(tx, {
        kind: 'conference_request',
        title: 'New conference request',
        body: `${conference.acronym} — ${conference.title}`,
        conferenceId: conference.id,
      });
      await this.emails.requested(tx, conference, user.id);
      await this.audit.record(
        {
          action: 'conference.requested',
          actorId: user.id,
          entityType: 'conference',
          entityId: conference.id,
          client,
        },
        tx,
      );
      return conference.id;
    });
    return this.get(user, id);
  }

  /** The user's live and archived conferences, and their own requests still waiting or declined. */
  async listMine(user: AuthUser): Promise<MyConferencesResponse> {
    const db = this.database.db;
    const [rows, superAdmin] = await Promise.all([
      this.conferences.listForUser(db, user.id),
      this.access.isSuperAdmin(user),
    ]);
    const chairOf = (roles: string[]) =>
      roles.some((r) => (CHAIR_ROLES as readonly string[]).includes(r));
    const deletionRequests = await this.conferences.latestDeletionRequests(
      db,
      rows.filter((r) => superAdmin || chairOf(r.activeRoles)).map((r) => r.id),
    );

    const conferences: ConferenceResponse[] = [];
    const requests: ConferenceResponse[] = [];
    for (const row of rows) {
      const myRoles = [...row.activeRoles, ...(row.isAuthor ? ['author'] : [])];
      const view = {
        myRoles,
        isChair: superAdmin || chairOf(row.activeRoles),
        deletionRequest: deletionRequests.get(row.id),
      };
      if (row.status === 'active' || row.status === 'archived') {
        if (myRoles.length > 0) {
          conferences.push(toConference(row, view));
        }
      } else if (row.createdBy === user.id) {
        requests.push(toConference(row, view));
      }
    }
    return { conferences, requests };
  }

  async get(user: AuthUser, conferenceId: string): Promise<ConferenceResponse> {
    const access = await this.access.requireConference(user, conferenceId);
    const row = await this.findOrFail(this.database.db, conferenceId);
    return this.view(row, access);
  }

  /** Chairs edit the details. `details` keys are merged into the stored ones. */
  async update(
    user: AuthUser,
    conferenceId: string,
    dto: UpdateConferenceDto,
    client: ClientInfo,
  ): Promise<ConferenceResponse> {
    await this.database.transaction(async (tx) => {
      const access = await this.requireChair(tx, user, conferenceId);
      const current = await this.conferences.lockForUpdate(tx, conferenceId);
      if (!current) {
        throw AppException.notFound('The conference');
      }
      this.assertEditable(access);
      const { details, ...fields } = dto;
      const values: Partial<ConferenceInsert> = Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined),
      );
      for (const key of [
        'submissionDeadline',
        'reviewDeadline',
        'cameraReadyDeadline',
      ] as const) {
        const value = dto[key];
        if (value !== undefined) {
          values[key] = value === null ? null : new Date(value);
        }
      }
      this.assertDateOrder(
        dto.startDate !== undefined ? dto.startDate : current.startDate,
        dto.endDate !== undefined ? dto.endDate : current.endDate,
      );
      // Amounts are stored without a currency: changing it would change what they mean.
      if (
        dto.currency !== undefined &&
        dto.currency !== current.currency &&
        current.currency !== null &&
        (await this.conferences.hasRecordedAmounts(tx, conferenceId))
      ) {
        throw AppException.businessRule(
          `Payments are already recorded in ${current.currency}, so the currency can't be changed.`,
        );
      }
      if (details) {
        values.details = {
          ...(current.details as Record<string, unknown>),
          ...details,
        };
      }
      if (Object.keys(values).length === 0) {
        return;
      }
      await this.conferences.update(tx, conferenceId, values);
      await this.audit.record(
        {
          action: 'conference.updated',
          actorId: user.id,
          entityType: 'conference',
          entityId: conferenceId,
          client,
          data: { fields: Object.keys(values) },
        },
        tx,
      );
    });
    return this.get(user, conferenceId);
  }

  /** Replaces the given top-level settings keys; null removes a key. */
  async updateSettings(
    user: AuthUser,
    conferenceId: string,
    patch: Record<string, unknown>,
  ): Promise<ConferenceResponse> {
    await this.database.transaction(async (tx) => {
      const access = await this.requireChair(tx, user, conferenceId);
      this.assertEditable(access);
      const current = await this.conferences.lockForUpdate(tx, conferenceId);
      const settings = {
        ...((current?.settings ?? {}) as Record<string, unknown>),
      };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
          delete settings[key];
        } else {
          settings[key] = value;
        }
      }
      await this.conferences.update(tx, conferenceId, { settings });
    });
    return this.get(user, conferenceId);
  }

  /**
   * Saves the chair's own setup-guide progress (settings.setupTour[userId]) without touching
   * other chairs' entries, so two chairs setting up at once don't overwrite each other.
   */
  async saveSetupProgress(
    user: AuthUser,
    conferenceId: string,
    progress: Record<string, unknown>,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      await this.requireChair(tx, user, conferenceId);
      const current = await this.conferences.lockForUpdate(tx, conferenceId);
      const settings = (current?.settings ?? {}) as Record<string, unknown>;
      const tour = (settings.setupTour ?? {}) as Record<string, unknown>;
      await this.conferences.update(tx, conferenceId, {
        settings: { ...settings, setupTour: { ...tour, [user.id]: progress } },
      });
    });
  }

  /** Active → archived: no new papers; everything already there stays. */
  async archive(
    user: AuthUser,
    conferenceId: string,
    client: ClientInfo,
  ): Promise<ConferenceResponse> {
    await this.database.transaction(async (tx) => {
      await this.requireChair(tx, user, conferenceId);
      if (
        !(await this.conferences.moveStatus(tx, conferenceId, 'active', {
          status: 'archived',
        }))
      ) {
        throw AppException.businessRule(
          'Only an active conference can be archived.',
        );
      }
      await this.record(tx, 'conference.archived', user, conferenceId, client);
    });
    return this.get(user, conferenceId);
  }

  /** Archived → active. A pending deletion request is taken back. */
  async restore(
    user: AuthUser,
    conferenceId: string,
    client: ClientInfo,
  ): Promise<ConferenceResponse> {
    await this.database.transaction(async (tx) => {
      await this.requireChair(tx, user, conferenceId);
      if (
        !(await this.conferences.moveStatus(tx, conferenceId, 'archived', {
          status: 'active',
        }))
      ) {
        throw AppException.businessRule(
          'Only an archived conference can be restored.',
        );
      }
      await this.conferences.closePendingDeletionRequest(
        tx,
        { conferenceId },
        { status: 'cancelled' },
      );
      await this.record(tx, 'conference.restored', user, conferenceId, client);
    });
    return this.get(user, conferenceId);
  }

  /** A chair of an archived conference asks a super admin to delete it. */
  async requestDeletion(
    user: AuthUser,
    conferenceId: string,
    reason: string,
    client: ClientInfo,
  ): Promise<ConferenceResponse> {
    await this.database.transaction(async (tx) => {
      const access = await this.requireChair(tx, user, conferenceId);
      if (access.status !== 'archived') {
        throw AppException.businessRule(
          'Archive the conference first: only an archived conference can be deleted.',
        );
      }
      const open = await this.conferences.latestDeletionRequests(tx, [
        conferenceId,
      ]);
      if (open.get(conferenceId)?.status === 'pending') {
        throw AppException.conflict(
          'A deletion request for this conference is already waiting for the Super Admin.',
        );
      }
      await this.conferences.insertDeletionRequest(tx, {
        conferenceId,
        requestedBy: user.id,
        reason,
      });
      const conference = await this.findOrFail(tx, conferenceId);
      await this.notifications.notifySuperAdmins(tx, {
        kind: 'conference_deletion_request',
        title: `Deletion requested: ${conference.acronym}`,
        body: reason,
        conferenceId,
      });
      await this.record(
        tx,
        'conference.deletion_requested',
        user,
        conferenceId,
        client,
      );
    });
    return this.get(user, conferenceId);
  }

  async cancelDeletion(
    user: AuthUser,
    conferenceId: string,
    client: ClientInfo,
  ): Promise<ConferenceResponse> {
    await this.database.transaction(async (tx) => {
      await this.requireChair(tx, user, conferenceId);
      const closed = await this.conferences.closePendingDeletionRequest(
        tx,
        { conferenceId },
        { status: 'cancelled' },
      );
      if (!closed) {
        throw AppException.businessRule(
          'There is no open deletion request for this conference.',
        );
      }
      await this.record(
        tx,
        'conference.deletion_cancelled',
        user,
        conferenceId,
        client,
      );
    });
    return this.get(user, conferenceId);
  }

  // Public -----------------------------------------------------------------------------------

  /** The Smart CFP directory: open calls of approved conferences that haven't ended. */
  async directory(): Promise<DirectoryEntryResponse[]> {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await this.conferences.listPublished(this.database.db, today);
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      acronym: row.acronym,
      title: row.title,
      about: row.about,
      mode: row.mode,
      city: row.city,
      country: row.country,
      primaryArea: row.primaryArea,
      secondaryArea: row.secondaryArea,
      startDate: row.startDate,
      endDate: row.endDate,
      submissionDeadline: row.submissionDeadline?.toISOString() ?? null,
      webPage: row.webPage,
      contactEmail: row.contactEmail,
      details: row.details as Record<string, unknown>,
      publishedAt: row.publishedAt?.toISOString() ?? null,
    }));
  }

  /**
   * A conference by its URL id, for the submission link: the public details of an active one, a
   * short notice for an archived one, otherwise not found.
   */
  async findPublic(
    slug: string,
  ): Promise<PublicConferenceResponse | ArchivedConferenceNotice> {
    const row = await this.conferences.findBySlug(this.database.db, slug);
    if (row?.status === 'active') {
      return toPublicConference(row);
    }
    if (row?.status === 'archived') {
      return { status: 'archived', acronym: row.acronym, title: row.title };
    }
    throw AppException.notFound('The conference');
  }

  /**
   * What the New Submission page needs, readable by authors (the chair's settings are not): the
   * tracks, submission types, extra questions and guidelines the chair chose.
   */
  async submissionForm(slug: string): Promise<SubmissionFormResponse> {
    const row = await this.conferences.findBySlug(this.database.db, slug);
    if (row?.status !== 'active') {
      throw AppException.notFound('The conference');
    }
    const settings = (row.settings ?? {}) as Record<string, unknown>;
    const obj = (v: unknown): Record<string, unknown> =>
      typeof v === 'object' && v && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : {};
    const strings = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        : [];
    const tracks = Array.isArray(settings.tracks)
      ? settings.tracks
          .map((t) => obj(t).name)
          .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
      : [];
    const extras = obj(settings.submissionForm).extras;
    const guidelines = obj(settings.submissionPolicy).guidelines;
    return {
      tracks,
      presentationTypes: strings(settings.presentationTypes),
      extras: Array.isArray(extras)
        ? (extras as Record<string, unknown>[])
        : [],
      guidelines: typeof guidelines === 'string' ? guidelines : '',
    };
  }

  // Helpers ----------------------------------------------------------------------------------

  /** The view of a conference the user is allowed: the full record, settings only for chairs. */
  async view(
    row: ConferenceWithCfp,
    access: ConferenceAccess,
  ): Promise<ConferenceResponse> {
    const isChair = isChairOf(access);
    const deletion = isChair
      ? (
          await this.conferences.latestDeletionRequests(this.database.db, [
            row.id,
          ])
        ).get(row.id)
      : undefined;
    return toConference(row, {
      myRoles: [...access.activeRoles, ...(access.isAuthor ? ['author'] : [])],
      isChair,
      deletionRequest: deletion,
    });
  }

  private async requireChair(
    tx: Tx,
    user: AuthUser,
    conferenceId: string,
  ): Promise<ConferenceAccess> {
    const access = await this.access.requireConference(user, conferenceId, tx);
    if (!canManageConference(access)) {
      throw AppException.forbidden(
        'Only a chair of this conference can do this.',
      );
    }
    return access;
  }

  /** A declined or deleted conference can't be changed (approval can't be bypassed by edits). */
  private assertEditable(access: ConferenceAccess): void {
    if (access.status === 'rejected' || access.status === 'deleted') {
      throw AppException.businessRule(
        'This conference was declined or deleted and can no longer be changed.',
      );
    }
  }

  private assertDateOrder(
    start: string | null | undefined,
    end: string | null | undefined,
  ): void {
    if (start && end && end < start) {
      throw AppException.validation('The end date is before the start date.', [
        { field: 'endDate', errors: ['must be on or after startDate'] },
      ]);
    }
  }

  private async findOrFail(
    tx: Parameters<ConferencesRepository['findById']>[0],
    conferenceId: string,
  ): Promise<ConferenceWithCfp> {
    const row = await this.conferences.findById(tx, conferenceId);
    if (!row) {
      throw AppException.notFound('The conference');
    }
    return row;
  }

  /** A free URL id: the acronym's, or with -2, -3… when it is taken. */
  private async freeSlug(tx: Tx, acronym: string): Promise<string> {
    const base = slugFromAcronym(acronym) || 'conference';
    const taken = await this.conferences.slugsLike(tx, base);
    if (!taken.has(base)) {
      return base;
    }
    for (let n = 2; n <= MAX_SLUG_SUFFIX; n++) {
      if (!taken.has(`${base}-${n}`)) {
        return `${base}-${n}`;
      }
    }
    throw AppException.conflict(
      'That acronym is already taken by another conference: add the year or another word to it.',
    );
  }

  private record(
    tx: Tx,
    action: string,
    user: AuthUser,
    conferenceId: string,
    client: ClientInfo,
  ): Promise<void> {
    return this.audit.record(
      {
        action,
        actorId: user.id,
        entityType: 'conference',
        entityId: conferenceId,
        client,
      },
      tx,
    );
  }
}
