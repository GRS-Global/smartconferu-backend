import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Executor } from '../../core/database/database.types.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import type {
  CreateInstitutionDto,
  CreateResearchAreaDto,
  CreateSocietyDto,
  InstitutionResponse,
  ResearchAreaGroupResponse,
  SocietyResponse,
  UpdateInstitutionDto,
  UpdateResearchAreaDto,
  UpdateSocietyDto,
} from './dto/master-data.dto.js';
import {
  type InstitutionRow,
  MasterDataRepository,
  type ResearchAreaRow,
  type SocietyRow,
} from './master-data.repository.js';

const isUniqueViolation = (error: unknown): boolean =>
  (error as { cause?: { code?: string } })?.cause?.code === '23505';

/** "IEEE CS" → "ieee-cs". */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'entry'
  );
}

const toSociety = (s: SocietyRow): SocietyResponse => ({
  id: s.id,
  key: s.key,
  name: s.name,
  acronym: s.acronym,
  url: s.url,
  status: s.status,
  updatedAt: s.updatedAt.toISOString(),
});

/**
 * The master-data lists: societies, institutions and research areas. Everyone signed in reads the
 * active entries (the app's pickers); the Super Admin adds, edits, deactivates / retires and
 * merges (admin › Master data). Every change is audited.
 */
@Injectable()
export class MasterDataService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repo: MasterDataRepository,
    private readonly audit: AuditService,
  ) {}

  // Societies ----------------------------------------------------------------------------------

  async societies(activeOnly: boolean): Promise<SocietyResponse[]> {
    return (await this.repo.listSocieties(activeOnly)).map(toSociety);
  }

  async createSociety(
    user: AuthUser,
    dto: CreateSocietyDto,
    client: ClientInfo,
  ): Promise<SocietyResponse> {
    return this.unique(
      'A society with this acronym is already on the list.',
      () =>
        this.database.transaction(async (tx) => {
          const row = await this.repo.insertSociety(
            {
              key: await this.freeKey(dto.acronym, tx, 'society'),
              name: dto.name,
              acronym: dto.acronym,
              url: dto.url ?? null,
              updatedBy: user.id,
            },
            tx,
          );
          await this.record(
            user,
            client,
            'admin.society_created',
            'society',
            row.id,
            { acronym: row.acronym },
            tx,
          );
          return toSociety(row);
        }),
    );
  }

  async updateSociety(
    user: AuthUser,
    id: string,
    dto: UpdateSocietyDto,
    client: ClientInfo,
  ): Promise<SocietyResponse> {
    return this.unique(
      'A society with this acronym is already on the list.',
      () =>
        this.database.transaction(async (tx) => {
          const current = await this.repo.findSociety(id, tx);
          if (!current) {
            throw AppException.notFound('Society');
          }
          const row = await this.repo.updateSociety(
            id,
            {
              ...(dto.name !== undefined && { name: dto.name }),
              ...(dto.acronym !== undefined && { acronym: dto.acronym }),
              ...(dto.url !== undefined && { url: dto.url }),
              ...(dto.status !== undefined && { status: dto.status }),
              updatedBy: user.id,
            },
            tx,
          );
          await this.record(
            user,
            client,
            'admin.society_updated',
            'society',
            id,
            { changed: Object.keys(dto), status: row.status },
            tx,
          );
          return toSociety(row);
        }),
    );
  }

  // Institutions -------------------------------------------------------------------------------

  async institutions(
    activeOnly: boolean,
    search?: string,
  ): Promise<InstitutionResponse[]> {
    const rows = await this.repo.listInstitutions(activeOnly, search);
    const people = activeOnly
      ? new Map<string, number>()
      : await this.repo.peopleByAffiliation();
    const byId = new Map(rows.map((r) => [r.id, r]));
    return rows.map((r) => this.toInstitution(r, byId, people));
  }

  async createInstitution(
    user: AuthUser,
    dto: CreateInstitutionDto,
    client: ClientInfo,
  ): Promise<InstitutionResponse> {
    return this.unique(
      'An institution with this name is already on the list.',
      () =>
        this.database.transaction(async (tx) => {
          const row = await this.repo.insertInstitution(
            {
              key: await this.freeKey(dto.name, tx, 'institution'),
              name: dto.name,
              aliases: dto.aliases ?? [],
              country: dto.country ?? null,
              departments: dto.departments ?? [],
              updatedBy: user.id,
            },
            tx,
          );
          await this.record(
            user,
            client,
            'admin.institution_created',
            'institution',
            row.id,
            { name: row.name },
            tx,
          );
          return this.toInstitution(row, new Map(), new Map());
        }),
    );
  }

  async updateInstitution(
    user: AuthUser,
    id: string,
    dto: UpdateInstitutionDto,
    client: ClientInfo,
  ): Promise<InstitutionResponse> {
    return this.unique(
      'An institution with this name is already on the list.',
      () =>
        this.database.transaction(async (tx) => {
          const current = await this.repo.findInstitution(id, tx);
          if (!current) {
            throw AppException.notFound('Institution');
          }
          const row = await this.repo.updateInstitution(
            id,
            {
              ...(dto.name !== undefined && { name: dto.name }),
              ...(dto.aliases !== undefined && { aliases: dto.aliases }),
              ...(dto.country !== undefined && { country: dto.country }),
              ...(dto.departments !== undefined && {
                departments: dto.departments,
              }),
              ...(dto.status !== undefined && {
                status: dto.status,
                // Restoring a merged institution undoes the merge link (its old names stay on
                // the other one as short forms, which is harmless).
                ...(dto.status === 'active' && { mergedIntoId: null }),
              }),
              updatedBy: user.id,
            },
            tx,
          );
          await this.record(
            user,
            client,
            'admin.institution_updated',
            'institution',
            id,
            { changed: Object.keys(dto), status: row.status },
            tx,
          );
          return this.toInstitution(row, new Map(), new Map());
        }),
    );
  }

  /**
   * Merges a duplicate into the institution to keep: the duplicate's name and short forms become
   * short forms of the kept one (so a search for them still finds it), and the duplicate retires.
   */
  async mergeInstitution(
    user: AuthUser,
    id: string,
    intoId: string,
    client: ClientInfo,
  ): Promise<InstitutionResponse> {
    if (id === intoId) {
      throw AppException.businessRule(
        'Choose a different institution to merge into.',
      );
    }
    return this.database.transaction(async (tx) => {
      const from = await this.repo.findInstitution(id, tx);
      const into = await this.repo.findInstitution(intoId, tx);
      if (!from || !into) {
        throw AppException.notFound('Institution');
      }
      if (from.status !== 'active' || into.status !== 'active') {
        throw AppException.businessRule(
          'Only two active institutions can be merged.',
        );
      }
      const known = new Set(
        [into.name, ...into.aliases].map((a) => a.toLowerCase()),
      );
      const aliases = [...into.aliases];
      for (const name of [from.name, ...from.aliases]) {
        if (!known.has(name.toLowerCase())) {
          known.add(name.toLowerCase());
          aliases.push(name);
        }
      }
      const departments = [...into.departments];
      const knownDepartments = new Set(departments.map((d) => d.toLowerCase()));
      for (const d of from.departments) {
        if (!knownDepartments.has(d.toLowerCase())) {
          knownDepartments.add(d.toLowerCase());
          departments.push(d);
        }
      }
      const kept = await this.repo.updateInstitution(
        into.id,
        { aliases, departments, updatedBy: user.id },
        tx,
      );
      await this.repo.updateInstitution(
        from.id,
        { status: 'retired', mergedIntoId: into.id, updatedBy: user.id },
        tx,
      );
      await this.record(
        user,
        client,
        'admin.institution_merged',
        'institution',
        from.id,
        { name: from.name, into: { id: into.id, name: into.name } },
        tx,
      );
      return this.toInstitution(kept, new Map(), new Map());
    });
  }

  // Research areas -----------------------------------------------------------------------------

  async researchAreas(admin: boolean): Promise<ResearchAreaGroupResponse[]> {
    const rows = await this.repo.listResearchAreas(!admin);
    const counts = admin
      ? await this.repo.conferenceAreaCounts()
      : { primary: new Map<string, number>(), pair: new Map<string, number>() };
    const groups: ResearchAreaGroupResponse[] = [];
    const byLabel = new Map<string, ResearchAreaGroupResponse>();
    const children = new Map<string, ResearchAreaRow[]>();
    for (const r of rows) {
      if (r.parentId) {
        children.set(r.parentId, [...(children.get(r.parentId) ?? []), r]);
      }
    }
    for (const p of rows) {
      if (p.parentId) continue;
      const label = p.groupLabel ?? 'Other';
      let group = byLabel.get(label);
      if (!group) {
        group = { label, areas: [] };
        byLabel.set(label, group);
        groups.push(group);
      }
      group.areas.push({
        id: p.id,
        name: p.name,
        status: p.status,
        conferences: counts.primary.get(p.name) ?? 0,
        subareas: (children.get(p.id) ?? []).map((s) => ({
          id: s.id,
          name: s.name,
          status: s.status,
          conferences: counts.pair.get(`${p.name}\u0000${s.name}`) ?? 0,
        })),
      });
    }
    return groups;
  }

  async createResearchArea(
    user: AuthUser,
    dto: CreateResearchAreaDto,
    client: ClientInfo,
  ): Promise<{ id: string }> {
    if (!dto.parentId && !dto.groupLabel) {
      throw AppException.validation(
        'Give the heading (groupLabel) for a new primary area, or the primary area (parentId) for a secondary one.',
      );
    }
    return this.unique('This research area is already on the list.', () =>
      this.database.transaction(async (tx) => {
        let parent: ResearchAreaRow | undefined;
        if (dto.parentId) {
          parent = await this.repo.findResearchArea(dto.parentId, tx);
          if (!parent || parent.parentId) {
            throw AppException.notFound('Primary research area');
          }
        }
        const row = await this.repo.insertResearchArea(
          {
            parentId: parent?.id ?? null,
            groupLabel: parent ? null : dto.groupLabel,
            name: dto.name,
            sortOrder: await this.repo.nextSortOrder(parent?.id ?? null, tx),
            updatedBy: user.id,
          },
          tx,
        );
        await this.record(
          user,
          client,
          'admin.research_area_created',
          'research_area',
          row.id,
          { name: row.name, under: parent?.name ?? dto.groupLabel },
          tx,
        );
        return { id: row.id };
      }),
    );
  }

  /** Renames (and renames it on every conference using it) or retires / restores an area. */
  async updateResearchArea(
    user: AuthUser,
    id: string,
    dto: UpdateResearchAreaDto,
    client: ClientInfo,
  ): Promise<{ id: string; conferencesRenamed: number }> {
    return this.unique('This research area is already on the list.', () =>
      this.database.transaction(async (tx) => {
        const current = await this.repo.findResearchArea(id, tx);
        if (!current) {
          throw AppException.notFound('Research area');
        }
        let renamed = 0;
        if (dto.name !== undefined && dto.name !== current.name) {
          const parent = current.parentId
            ? await this.repo.findResearchArea(current.parentId, tx)
            : undefined;
          renamed = await this.repo.renameOnConferences(
            parent ? 'secondary' : 'primary',
            parent?.name ?? current.name,
            current.name,
            dto.name,
            tx,
          );
        }
        await this.repo.updateResearchArea(
          id,
          {
            ...(dto.name !== undefined && { name: dto.name }),
            ...(dto.status !== undefined && { status: dto.status }),
            updatedBy: user.id,
          },
          tx,
        );
        await this.record(
          user,
          client,
          'admin.research_area_updated',
          'research_area',
          id,
          {
            from: current.name,
            name: dto.name,
            status: dto.status,
            conferencesRenamed: renamed,
          },
          tx,
        );
        return { id, conferencesRenamed: renamed };
      }),
    );
  }

  // Helpers ------------------------------------------------------------------------------------

  private toInstitution(
    r: InstitutionRow,
    byId: Map<string, InstitutionRow>,
    people: Map<string, number>,
  ): InstitutionResponse {
    const into = r.mergedIntoId ? byId.get(r.mergedIntoId) : undefined;
    return {
      id: r.id,
      key: r.key,
      name: r.name,
      aliases: r.aliases,
      country: r.country,
      departments: r.departments,
      status: r.status,
      mergedInto: r.mergedIntoId
        ? { id: r.mergedIntoId, name: into?.name ?? '' }
        : null,
      people: people.get(r.name.toLowerCase()) ?? 0,
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  /** A key not used yet: the slug, or the slug with -2, -3… */
  async freeKey(
    text: string,
    tx: Executor,
    kind: 'society' | 'institution',
  ): Promise<string> {
    const base = slugify(text);
    const taken = new Set(await this.repo.keysStartingWith(kind, base, tx));
    let key = base;
    for (let n = 2; taken.has(key); n++) {
      key = `${base}-${n}`;
    }
    return key;
  }

  private async unique<T>(message: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw AppException.conflict(message);
      }
      throw error;
    }
  }

  private record(
    user: AuthUser,
    client: ClientInfo,
    action: string,
    entityType: string,
    entityId: string,
    data: Record<string, unknown>,
    tx: Executor,
  ): Promise<void> {
    return this.audit.record(
      { action, actorId: user.id, entityType, entityId, client, data },
      tx,
    );
  }
}
