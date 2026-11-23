import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Executor } from '../../core/database/database.types.js';
import {
  profileDetails,
  profileRequests,
  profiles,
  researchAreas,
  users,
} from '../../core/database/schema/index.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import {
  EmailQueueService,
  type WrittenEmail,
} from '../../core/email/email-queue.service.js';
import { EmailRecipientsService } from '../../core/email/email-recipients.service.js';
import { escapeHtml, firstName } from '../../core/email/email-render.js';
import { NotificationsService } from '../../core/notifications/notifications.service.js';
import type {
  ApproveProfileRequestDto,
  ProfileRequestResponse,
  RejectProfileRequestDto,
} from './dto/profile-requests.dto.js';
import { MasterDataRepository } from './master-data.repository.js';
import { MasterDataService } from './master-data.service.js';

type Kind = 'institution' | 'society' | 'research_area';

const PAGE: Record<Kind, string> = {
  institution: '/super-admin/institutions?tab=requests',
  society: '/super-admin/societies?tab=requests',
  research_area: '/super-admin/research-areas?tab=requests',
};
const LABEL: Record<Kind, string> = {
  institution: 'institution',
  society: 'society',
  research_area: 'research area',
};
type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** "IIT  Bombay!" and "iit bombay" are the same name. */
export const nameKey = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '');

const unresolved = (verification: unknown) =>
  verification !== 'approved' && verification !== 'rejected';

interface Wanted {
  kind: Kind;
  name: string;
  url: string | null;
  /** A secondary research area: the primary area it was typed under. */
  parentName?: string | null;
}

/** The request's identity: the same name (and, for a secondary area, the same primary area). */
const keyOf = (name: string, parentName?: string | null) =>
  nameKey(`${parentName ?? ''}|${name}`);

/** The new names a profile asks to have added (typed by the member, "Pending review"). */
export function wantedFromDetails(details: Json): Wanted[] {
  const out = new Map<string, Wanted>();
  const add = (
    kind: Kind,
    name: string,
    url: string | null,
    parentName: string | null = null,
  ) => {
    const key = keyOf(name, parentName);
    if (nameKey(name) && !out.has(`${kind}:${key}`)) {
      out.set(`${kind}:${key}`, { kind, name, url, parentName });
    }
  };
  const affiliations = Array.isArray(details.affiliations)
    ? details.affiliations
    : [];
  for (const a of affiliations) {
    if (isRecord(a) && a.pending === true && !str(a.institutionId)) {
      add('institution', str(a.institution), null);
    }
  }
  const timeline = Array.isArray(details.timeline) ? details.timeline : [];
  for (const e of timeline) {
    if (
      isRecord(e) &&
      e.type === 'membership' &&
      e.societyId === 'other' &&
      unresolved(e.verification)
    ) {
      add('society', str(e.org), str(e.societyUrl) || null);
    }
  }
  const primary = str(details.primaryArea);
  if (primary && details.primaryAreaPending === true) {
    add('research_area', primary, null);
  }
  if (primary && Array.isArray(details.pendingSecondaryAreas)) {
    for (const sub of details.pendingSecondaryAreas) {
      if (str(sub)) add('research_area', str(sub), null, primary);
    }
  }
  return [...out.values()];
}

/**
 * New institutions and societies members typed. A request is filed when a profile is saved with
 * one ("Pending review"); the Super Admin approves it into the master data (every member who typed
 * that name gets it linked, and a notification) or rejects it with a reason.
 */
@Injectable()
export class ProfileRequestsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repo: MasterDataRepository,
    private readonly masterData: MasterDataService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly emailQueue: EmailQueueService,
    private readonly recipients: EmailRecipientsService,
  ) {}

  /** Called when a profile is saved: files a request for each new name and tells the Super Admins. */
  async syncFromProfile(
    tx: Executor,
    userId: string,
    details: Json,
  ): Promise<void> {
    for (const w of wantedFromDetails(details)) {
      const rows = await tx
        .insert(profileRequests)
        .values({
          kind: w.kind,
          name: w.name,
          nameKey: keyOf(w.name, w.parentName),
          parentName: w.parentName ?? null,
          url: w.url,
          userId,
        })
        .onConflictDoNothing()
        .returning({ id: profileRequests.id });
      if (rows.length > 0) {
        await this.notifications.notifySuperAdmins(tx, {
          kind: `profile_request_${w.kind}`,
          title: `New ${LABEL[w.kind]} to review: ${w.name}`,
          body: 'A member typed a name that is not on the list yet.',
          link: PAGE[w.kind],
        });
      }
    }
  }

  /** The queue: people who typed the same name are one item. */
  async list(
    status: 'pending' | 'resolved',
    kind?: Kind,
  ): Promise<ProfileRequestResponse[]> {
    const rows = await this.database.db
      .select({
        id: profileRequests.id,
        kind: profileRequests.kind,
        name: profileRequests.name,
        parentName: profileRequests.parentName,
        nameKey: profileRequests.nameKey,
        url: profileRequests.url,
        status: profileRequests.status,
        resolvedName: profileRequests.resolvedName,
        reason: profileRequests.reason,
        resolvedAt: profileRequests.resolvedAt,
        createdAt: profileRequests.createdAt,
        userId: profileRequests.userId,
        firstName: profiles.firstName,
        lastName: profiles.lastName,
        email: users.email,
      })
      .from(profileRequests)
      .innerJoin(users, eq(users.id, profileRequests.userId))
      .leftJoin(profiles, eq(profiles.id, profileRequests.userId))
      .where(
        and(
          status === 'pending'
            ? eq(profileRequests.status, 'pending')
            : inArray(profileRequests.status, ['approved', 'rejected']),
          kind ? eq(profileRequests.kind, kind) : undefined,
        ),
      )
      .orderBy(asc(profileRequests.createdAt));
    const groups = new Map<string, ProfileRequestResponse>();
    for (const r of rows) {
      const gk = `${r.kind}:${r.nameKey}:${r.status}:${r.resolvedAt?.toISOString() ?? ''}`;
      const person = {
        id: r.userId,
        name:
          [r.firstName, r.lastName].filter(Boolean).join(' ') ||
          r.email ||
          'A member',
        email: r.email,
      };
      const group = groups.get(gk);
      if (group) {
        group.requesters.push(person);
        if (r.createdAt.toISOString() < group.createdAt) {
          group.createdAt = r.createdAt.toISOString();
        }
        continue;
      }
      groups.set(gk, {
        id: r.id,
        kind: r.kind as Kind,
        name: r.name,
        parentName: r.parentName,
        url: r.url,
        status: r.status as ProfileRequestResponse['status'],
        resolvedName: r.resolvedName,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        requesters: [person],
      });
    }
    return [...groups.values()];
  }

  async approve(
    admin: AuthUser,
    id: string,
    dto: ApproveProfileRequestDto,
    client: ClientInfo,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      const group = await this.pendingGroup(id, tx);
      const first = group[0];
      const kind = first.kind as Kind;
      const typed = first.name;
      let entry: { id: string; key: string; name: string; created: boolean };

      if (kind === 'research_area') {
        entry = await this.areaEntry(admin, first, dto, tx);
      } else if (dto.intoId) {
        // The name is another spelling of something that is already listed.
        if (kind === 'institution') {
          const found = await this.repo.findInstitution(dto.intoId, tx);
          if (!found) throw AppException.notFound('That institution');
          if (
            !found.aliases.some((a) => a.toLowerCase() === typed.toLowerCase())
          ) {
            await this.repo.updateInstitution(
              found.id,
              { aliases: [...found.aliases, typed], updatedBy: admin.id },
              tx,
            );
          }
          entry = {
            id: found.id,
            key: found.key,
            name: found.name,
            created: false,
          };
        } else {
          const found = await this.repo.findSociety(dto.intoId, tx);
          if (!found) throw AppException.notFound('That society');
          entry = {
            id: found.id,
            key: found.key,
            name: found.name,
            created: false,
          };
        }
      } else if (kind === 'institution') {
        const name = (dto.name ?? typed).trim();
        const row = await this.insertOrConflict(async () =>
          this.repo.insertInstitution(
            {
              key: await this.masterData.freeKey(name, tx, 'institution'),
              name,
              aliases:
                name.toLowerCase() === typed.toLowerCase() ? [] : [typed],
              country: dto.country || null,
              updatedBy: admin.id,
            },
            tx,
          ),
        );
        entry = { id: row.id, key: row.key, name: row.name, created: true };
      } else {
        const name = (dto.name ?? typed).trim();
        const acronym = (dto.acronym ?? '').trim();
        if (!acronym) {
          throw AppException.validation('Add the official acronym.', [
            { field: 'acronym', errors: ['must not be empty'] },
          ]);
        }
        const row = await this.insertOrConflict(async () =>
          this.repo.insertSociety(
            {
              key: await this.masterData.freeKey(acronym, tx, 'society'),
              name,
              acronym,
              url: dto.url || first.url || null,
              updatedBy: admin.id,
            },
            tx,
          ),
        );
        entry = { id: row.id, key: row.key, name: row.name, created: true };
      }

      const userIds = group.map((g) => g.userId);
      for (const userId of userIds) {
        if (kind === 'research_area') {
          await this.rewriteAreas(tx, userId, first, { name: entry.name });
          continue;
        }
        await this.rewriteProfile(
          tx,
          userId,
          kind,
          first.nameKey,
          () =>
            kind === 'institution'
              ? {
                  institution: entry.name,
                  institutionId: entry.key,
                  pending: false,
                }
              : entry.created
                ? { org: entry.name, verification: 'approved' }
                : { org: entry.name, societyId: entry.key, verification: '' },
          entry.name,
        );
      }
      await tx
        .update(profileRequests)
        .set({
          status: 'approved',
          resolvedName: entry.name,
          resolvedId: entry.id,
          resolvedBy: admin.id,
          resolvedAt: new Date(),
        })
        .where(
          inArray(
            profileRequests.id,
            group.map((g) => g.id),
          ),
        );
      await this.notifications.notify(tx, userIds, {
        kind: 'profile_request_approved',
        title: `“${entry.name}” was approved`,
        body: `Your ${LABEL[kind]} is now on the list and no longer pending review.`,
        link: '/profile',
      });
      await this.audit.record(
        {
          action: 'admin.profile_request_approved',
          actorId: admin.id,
          entityType: kind,
          entityId: entry.id,
          client,
          data: {
            typed,
            name: entry.name,
            people: userIds.length,
            linkedToExisting: !entry.created,
          },
        },
        tx,
      );
    });
  }

  async reject(
    admin: AuthUser,
    id: string,
    dto: RejectProfileRequestDto,
    client: ClientInfo,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      const group = await this.pendingGroup(id, tx);
      const first = group[0];
      const kind = first.kind as Kind;
      const userIds = group.map((g) => g.userId);
      for (const userId of userIds) {
        if (kind === 'research_area') {
          await this.rewriteAreas(tx, userId, first, { reason: dto.reason });
          continue;
        }
        await this.rewriteProfile(
          tx,
          userId,
          kind,
          first.nameKey,
          () => null, // a rejected name is taken out of the profile
          null,
        );
      }
      await tx
        .update(profileRequests)
        .set({
          status: 'rejected',
          reason: dto.reason,
          resolvedBy: admin.id,
          resolvedAt: new Date(),
        })
        .where(
          inArray(
            profileRequests.id,
            group.map((g) => g.id),
          ),
        );
      await this.notifications.notify(tx, userIds, {
        kind: 'profile_request_rejected',
        title: `“${first.name}” was not accepted`,
        body: dto.reason,
        link: '/profile',
      });
      // A rejection is also emailed (an approval is not: the member sees it on their profile).
      const people = await this.recipients.people(tx, userIds);
      const profileLink = this.recipients.link('/profile');
      const emails = [...people.values()].map((person): WrittenEmail => ({
        key: 'profileRequestRejected',
        label: 'New name not accepted',
        recipientType: 'Member',
        to: person,
        subject: `“${first.name}” was not accepted`,
        body:
          `<p>Hi ${escapeHtml(firstName(person.name, person.email))},</p>` +
          `<p>You added the ${LABEL[kind]} <b>${escapeHtml(first.name)}</b> to your profile, but our team could not accept it:</p>` +
          `<p>“${escapeHtml(dto.reason)}”</p>` +
          `<p>Please open your profile and pick one from the list, or correct the name.</p>` +
          `<p><a href="${escapeHtml(profileLink)}" style="color:#4F46E5">${escapeHtml(profileLink)}</a></p>`,
      }));
      await this.emailQueue.enqueue(tx, 'profile_request_rejected', emails, {
        sentBy: admin.id,
      });
      await this.audit.record(
        {
          action: 'admin.profile_request_rejected',
          actorId: admin.id,
          entityType: kind,
          entityId: first.id,
          client,
          data: {
            typed: first.name,
            reason: dto.reason,
            people: userIds.length,
          },
        },
        tx,
      );
    });
  }

  // ---------------------------------------------------------------------------------------------

  /** Every still-pending row with the same name as request `id`. */
  private async pendingGroup(id: string, tx: Executor) {
    const [row] = await tx
      .select()
      .from(profileRequests)
      .where(eq(profileRequests.id, id));
    if (!row) throw AppException.notFound('That request');
    if (row.status !== 'pending') {
      throw AppException.conflict('This request was already answered.');
    }
    return tx
      .select()
      .from(profileRequests)
      .where(
        and(
          eq(profileRequests.kind, row.kind),
          eq(profileRequests.nameKey, row.nameKey),
          eq(profileRequests.status, 'pending'),
        ),
      )
      .orderBy(profileRequests.createdAt);
  }

  private async insertOrConflict<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if ((error as { cause?: { code?: string } })?.cause?.code === '23505') {
        throw AppException.conflict(
          'That name is already on the list. Choose "Same as one on the list" to link it.',
        );
      }
      throw error;
    }
  }

  /** The research-area entry an approval creates, or the existing one it is linked to. */
  private async areaEntry(
    admin: AuthUser,
    first: typeof profileRequests.$inferSelect,
    dto: ApproveProfileRequestDto,
    tx: Executor,
  ): Promise<{ id: string; key: string; name: string; created: boolean }> {
    const secondary = Boolean(first.parentName);
    if (dto.intoId) {
      const found = await this.repo.findResearchArea(dto.intoId, tx);
      if (!found || Boolean(found.parentId) !== secondary) {
        throw AppException.notFound('That research area');
      }
      return { id: found.id, key: found.id, name: found.name, created: false };
    }
    const name = (dto.name ?? first.name).trim();
    let parentId: string | null = null;
    if (secondary) {
      parentId =
        dto.parentId ??
        (await this.primaryAreaByName(first.parentName ?? '', tx)) ??
        null;
      const parent = parentId
        ? await this.repo.findResearchArea(parentId, tx)
        : undefined;
      if (!parent || parent.parentId) {
        throw AppException.conflict(
          `Add the primary area “${first.parentName}” first, then approve this one (or choose its primary area).`,
        );
      }
    } else if (!dto.group?.trim()) {
      throw AppException.validation(
        'Choose the heading this area sits under.',
        [{ field: 'group', errors: ['must not be empty'] }],
      );
    }
    const row = await this.insertOrConflict(async () =>
      this.repo.insertResearchArea(
        {
          parentId,
          groupLabel: parentId ? null : (dto.group ?? '').trim(),
          name,
          sortOrder: await this.repo.nextSortOrder(parentId, tx),
          updatedBy: admin.id,
        },
        tx,
      ),
    );
    return { id: row.id, key: row.id, name: row.name, created: true };
  }

  private async primaryAreaByName(
    name: string,
    tx: Executor,
  ): Promise<string | undefined> {
    const [row] = await tx
      .select({ id: researchAreas.id })
      .from(researchAreas)
      .where(
        and(
          isNull(researchAreas.parentId),
          eq(researchAreas.status, 'active'),
          sql`lower(${researchAreas.name}) = lower(${name})`,
        ),
      );
    return row?.id;
  }

  /** The member's research areas: the typed one becomes the listed name, or is taken out when rejected. */
  private async rewriteAreas(
    tx: Executor,
    userId: string,
    req: { name: string; parentName: string | null },
    outcome: { name: string } | { reason: string },
  ): Promise<void> {
    const [row] = await tx
      .select({ data: profileDetails.data })
      .from(profileDetails)
      .where(eq(profileDetails.userId, userId));
    if (!row || !isRecord(row.data)) return;
    const data: Json = { ...row.data };
    const key = nameKey(req.name);
    const strs = (v: unknown) =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === 'string')
        : [];
    let touched = false;
    if (!req.parentName) {
      if (
        data.primaryAreaPending === true &&
        nameKey(str(data.primaryArea)) === key
      ) {
        touched = true;
        data.primaryAreaPending = false;
        if ('name' in outcome) {
          data.primaryArea = outcome.name;
        } else {
          data.primaryArea = '';
          data.secondaryAreas = [];
          data.pendingSecondaryAreas = [];
        }
      }
    } else {
      const pending = strs(data.pendingSecondaryAreas);
      if (pending.some((x) => nameKey(x) === key)) {
        touched = true;
        data.pendingSecondaryAreas = pending.filter((x) => nameKey(x) !== key);
        data.secondaryAreas =
          'name' in outcome
            ? strs(data.secondaryAreas).map((x) =>
                nameKey(x) === key ? outcome.name : x,
              )
            : strs(data.secondaryAreas).filter((x) => nameKey(x) !== key);
      }
    }
    if (touched) {
      await tx
        .update(profileDetails)
        .set({ data })
        .where(eq(profileDetails.userId, userId));
    }
  }

  /** Changes the member's profile entries that still carry this typed name. */
  private async rewriteProfile(
    tx: Executor,
    userId: string,
    kind: Kind,
    key: string,
    /** The changes to the entry, or null to take it out of the profile. */
    change: (entry: Json) => Json | null,
    columnName: string | null,
  ): Promise<void> {
    const [row] = await tx
      .select({ data: profileDetails.data })
      .from(profileDetails)
      .where(eq(profileDetails.userId, userId));
    if (!row || !isRecord(row.data)) return;
    const data: Json = { ...row.data };
    let touched = false;
    if (kind === 'institution') {
      const list = Array.isArray(data.affiliations) ? data.affiliations : [];
      const kept: unknown[] = [];
      let removed = false;
      for (const a of list) {
        if (
          !isRecord(a) ||
          a.pending !== true ||
          nameKey(str(a.institution)) !== key
        ) {
          kept.push(a);
          continue;
        }
        touched = true;
        const patch = change(a);
        if (patch) kept.push({ ...a, ...patch });
        else removed = true;
      }
      data.affiliations = kept;
      // The primary affiliation is also kept as flat fields (and the profile's affiliation column).
      const [profile] = await tx
        .select({ affiliation: profiles.affiliation })
        .from(profiles)
        .where(eq(profiles.id, userId));
      const flatMatches =
        Boolean(profile?.affiliation) &&
        nameKey(profile?.affiliation ?? '') === key;
      if (removed && flatMatches) {
        // The primary one was taken out: the next one (if any) becomes the primary.
        const next = isRecord(kept[0]) ? kept[0] : undefined;
        if (next) kept[0] = { ...next, primary: true };
        data.affiliationPending = next?.pending === true;
        data.affiliationInstitutionId = str(next?.institutionId) || null;
        data.affiliationDepartment = str(next?.department);
        data.affiliationLocation = str(next?.location);
        data.affiliationStartMonth = str(next?.startMonth);
        data.affiliationStartYear = str(next?.startYear);
        await tx
          .update(profiles)
          .set({ affiliation: str(next?.institution) || null })
          .where(eq(profiles.id, userId));
        touched = true;
      } else if (flatMatches && data.affiliationPending === true) {
        const patch = change({});
        if (patch) {
          data.affiliationPending = patch.pending === true;
          if (typeof patch.institutionId === 'string') {
            data.affiliationInstitutionId = patch.institutionId;
          }
          if (columnName) {
            await tx
              .update(profiles)
              .set({ affiliation: columnName })
              .where(eq(profiles.id, userId));
          }
          touched = true;
        }
      }
    } else {
      const list = Array.isArray(data.timeline) ? data.timeline : [];
      const kept: unknown[] = [];
      for (const e of list) {
        if (
          !isRecord(e) ||
          e.type !== 'membership' ||
          e.societyId !== 'other' ||
          !unresolved(e.verification) ||
          nameKey(str(e.org)) !== key
        ) {
          kept.push(e);
          continue;
        }
        touched = true;
        const patch = change(e);
        if (patch) kept.push({ ...e, ...patch });
      }
      data.timeline = kept;
    }
    if (touched) {
      await tx
        .update(profileDetails)
        .set({ data })
        .where(eq(profileDetails.userId, userId));
    }
  }
}
