import { Injectable } from '@nestjs/common';
import { and, asc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Executor } from '../../core/database/database.types.js';
import {
  conferences,
  institutions,
  profiles,
  researchAreas,
  societies,
} from '../../core/database/schema/index.js';

export type SocietyRow = typeof societies.$inferSelect;
export type InstitutionRow = typeof institutions.$inferSelect;
export type ResearchAreaRow = typeof researchAreas.$inferSelect;

const escapeLike = (s: string) => s.replace(/[%_\\]/g, '\\$&');

/** Queries for the master-data lists (societies, institutions, research areas). */
@Injectable()
export class MasterDataRepository {
  constructor(private readonly database: DatabaseService) {}

  /** Keys already used that start with `base` (to pick a free one). */
  async keysStartingWith(
    kind: 'society' | 'institution',
    base: string,
    tx: Executor,
  ): Promise<string[]> {
    const table = kind === 'society' ? societies : institutions;
    const rows = await tx
      .select({ key: table.key })
      .from(table)
      .where(sql`${table.key} like ${escapeLike(base) + '%'}`);
    return rows.map((r) => r.key);
  }

  // Societies ----------------------------------------------------------------------------------

  listSocieties(activeOnly: boolean): Promise<SocietyRow[]> {
    return this.database.db
      .select()
      .from(societies)
      .where(activeOnly ? eq(societies.status, 'active') : undefined)
      .orderBy(asc(sql`lower(${societies.acronym})`));
  }

  async findSociety(id: string, tx: Executor): Promise<SocietyRow | undefined> {
    const [row] = await tx.select().from(societies).where(eq(societies.id, id));
    return row;
  }

  async insertSociety(
    values: typeof societies.$inferInsert,
    tx: Executor,
  ): Promise<SocietyRow> {
    const [row] = await tx.insert(societies).values(values).returning();
    return row;
  }

  async updateSociety(
    id: string,
    values: Partial<typeof societies.$inferInsert>,
    tx: Executor,
  ): Promise<SocietyRow> {
    const [row] = await tx
      .update(societies)
      .set(values)
      .where(eq(societies.id, id))
      .returning();
    return row;
  }

  // Institutions -------------------------------------------------------------------------------

  listInstitutions(
    activeOnly: boolean,
    search: string | undefined,
  ): Promise<InstitutionRow[]> {
    const like = search ? `%${escapeLike(search)}%` : undefined;
    return this.database.db
      .select()
      .from(institutions)
      .where(
        and(
          activeOnly ? eq(institutions.status, 'active') : undefined,
          like
            ? or(
                ilike(institutions.name, like),
                sql`exists (select 1 from unnest(${institutions.aliases}) a where a ilike ${like})`,
              )
            : undefined,
        ),
      )
      .orderBy(asc(sql`lower(${institutions.name})`));
  }

  async findInstitution(
    id: string,
    tx: Executor,
  ): Promise<InstitutionRow | undefined> {
    const [row] = await tx
      .select()
      .from(institutions)
      .where(eq(institutions.id, id))
      .for('update');
    return row;
  }

  async insertInstitution(
    values: typeof institutions.$inferInsert,
    tx: Executor,
  ): Promise<InstitutionRow> {
    const [row] = await tx.insert(institutions).values(values).returning();
    return row;
  }

  async updateInstitution(
    id: string,
    values: Partial<typeof institutions.$inferInsert>,
    tx: Executor,
  ): Promise<InstitutionRow> {
    const [row] = await tx
      .update(institutions)
      .set(values)
      .where(eq(institutions.id, id))
      .returning();
    return row;
  }

  /** Profiles per affiliation name (lower-cased), for the admin list's People column. */
  async peopleByAffiliation(): Promise<Map<string, number>> {
    const rows = await this.database.db
      .select({
        name: sql<string>`lower(${profiles.affiliation})`,
        n: sql<number>`count(*)::int`,
      })
      .from(profiles)
      .where(sql`${profiles.affiliation} is not null`)
      .groupBy(sql`lower(${profiles.affiliation})`);
    return new Map(rows.map((r) => [r.name, r.n]));
  }

  // Research areas -----------------------------------------------------------------------------

  listResearchAreas(activeOnly: boolean): Promise<ResearchAreaRow[]> {
    return this.database.db
      .select()
      .from(researchAreas)
      .where(activeOnly ? eq(researchAreas.status, 'active') : undefined)
      .orderBy(asc(researchAreas.sortOrder), asc(researchAreas.name));
  }

  async findResearchArea(
    id: string,
    tx: Executor,
  ): Promise<ResearchAreaRow | undefined> {
    const [row] = await tx
      .select()
      .from(researchAreas)
      .where(eq(researchAreas.id, id))
      .for('update');
    return row;
  }

  /** The next sort position among the siblings (primary areas, or the secondaries of one). */
  async nextSortOrder(parentId: string | null, tx: Executor): Promise<number> {
    const [row] = await tx
      .select({
        n: sql<number>`coalesce(max(${researchAreas.sortOrder}) + 1, 0)::int`,
      })
      .from(researchAreas)
      .where(
        parentId
          ? eq(researchAreas.parentId, parentId)
          : isNull(researchAreas.parentId),
      );
    return row?.n ?? 0;
  }

  async insertResearchArea(
    values: typeof researchAreas.$inferInsert,
    tx: Executor,
  ): Promise<ResearchAreaRow> {
    const [row] = await tx.insert(researchAreas).values(values).returning();
    return row;
  }

  async updateResearchArea(
    id: string,
    values: Partial<typeof researchAreas.$inferInsert>,
    tx: Executor,
  ): Promise<ResearchAreaRow> {
    const [row] = await tx
      .update(researchAreas)
      .set(values)
      .where(eq(researchAreas.id, id))
      .returning();
    return row;
  }

  /** Conferences per primary area and per "primary › secondary" pair. */
  async conferenceAreaCounts(): Promise<{
    primary: Map<string, number>;
    pair: Map<string, number>;
  }> {
    const rows = await this.database.db
      .select({
        primary: conferences.primaryArea,
        secondary: conferences.secondaryArea,
        n: sql<number>`count(*)::int`,
      })
      .from(conferences)
      .where(sql`${conferences.primaryArea} is not null`)
      .groupBy(conferences.primaryArea, conferences.secondaryArea);
    const primary = new Map<string, number>();
    const pair = new Map<string, number>();
    for (const r of rows) {
      const p = r.primary ?? '';
      primary.set(p, (primary.get(p) ?? 0) + r.n);
      if (r.secondary) {
        pair.set(`${p}\u0000${r.secondary}`, r.n);
      }
    }
    return { primary, pair };
  }

  /** Renames an area on the conferences that use it (they store the names as text). */
  async renameOnConferences(
    level: 'primary' | 'secondary',
    primaryName: string,
    from: string,
    to: string,
    tx: Executor,
  ): Promise<number> {
    const rows =
      level === 'primary'
        ? await tx
            .update(conferences)
            .set({ primaryArea: to })
            .where(eq(conferences.primaryArea, from))
            .returning({ id: conferences.id })
        : await tx
            .update(conferences)
            .set({ secondaryArea: to })
            .where(
              and(
                eq(conferences.primaryArea, primaryName),
                eq(conferences.secondaryArea, from),
              ),
            )
            .returning({ id: conferences.id });
    return rows.length;
  }
}
