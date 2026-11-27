import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNull,
  like,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { Executor } from '../../core/database/database.types.js';
import { DECISION_TEMPLATE_KEYS } from './decision-emails.js';
import {
  cfps,
  conferenceDeletionRequests,
  conferenceEmailTemplates,
  conferenceMembers,
  conferences,
  decisionTypes,
  emailTemplates,
  profiles,
  submissionAuthors,
  submissions,
  users,
} from '../../core/database/schema/index.js';

export type ConferenceRow = typeof conferences.$inferSelect;
export type ConferenceInsert = typeof conferences.$inferInsert;
export type CfpRow = typeof cfps.$inferSelect;
export type DeletionRequestRow = typeof conferenceDeletionRequests.$inferSelect;

/** A conference with its CFP status. */
export type ConferenceWithCfp = ConferenceRow & { cfpStatus: CfpRow['status'] };

/** A conference as listed for one user: plus their roles and whether they wrote a paper there. */
export type MyConferenceRow = ConferenceWithCfp & {
  activeRoles: string[];
  isAuthor: boolean;
};

/** The decision labels every new conference starts with (the old handle_new_conference trigger). */
const DEFAULT_DECISION_TYPES = [
  ['Paper Upload Pending', '#64748B', 'upload_pending'],
  ['No Decision', '#94A3B8', 'no_decision'],
  ['Plagiarism clear', '#0EA5E9', 'plagiarism_clear'],
  ['Revision', '#F59E0B', 'revise'],
  ['Waitlist', '#8B5CF6', 'waitlist'],
  ['Accept', '#16A34A', 'accept'],
  ['Registered', '#0D9488', 'registered'],
  ['Reject', '#DC2626', 'reject'],
] as const;

const withCfp = {
  ...getTableColumns(conferences),
  cfpStatus: sql<
    CfpRow['status']
  >`coalesce(${cfps.status}, 'draft'::cfp_status)`.as('cfp_status'),
};

/** Database access for conferences, their CFP and deletion requests. */
@Injectable()
export class ConferencesRepository {
  async findById(
    tx: Executor,
    id: string,
  ): Promise<ConferenceWithCfp | undefined> {
    const [row] = await tx
      .select(withCfp)
      .from(conferences)
      .leftJoin(cfps, eq(cfps.conferenceId, conferences.id))
      .where(eq(conferences.id, id));
    return row;
  }

  async findBySlug(
    tx: Executor,
    slug: string,
  ): Promise<ConferenceWithCfp | undefined> {
    const [row] = await tx
      .select(withCfp)
      .from(conferences)
      .leftJoin(cfps, eq(cfps.conferenceId, conferences.id))
      .where(eq(conferences.slug, slug));
    return row;
  }

  /** Slugs already taken that start with `base` (base, base-2, base-3…). */
  async slugsLike(tx: Executor, base: string): Promise<Set<string>> {
    const rows = await tx
      .select({ slug: conferences.slug })
      .from(conferences)
      .where(
        or(eq(conferences.slug, base), like(conferences.slug, `${base}-%`)),
      );
    return new Set(rows.map((r) => r.slug));
  }

  /**
   * Whether another conference that is waiting, live or archived already has this acronym, compared by its letters and digits only
   * ("QAC 2027" = "qac-2027"). Declined, cancelled and deleted ones do not count. Two of them would number their papers alike ("QAC-1").
   */
  async acronymTaken(tx: Executor, acronym: string): Promise<boolean> {
    const key = acronym.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    if (!key) {
      return false;
    }
    const [row] = await tx
      .select({ id: conferences.id })
      .from(conferences)
      .where(
        and(
          inArray(conferences.status, [
            'pending_approval',
            'active',
            'archived',
          ]),
          sql`lower(regexp_replace(${conferences.acronym}, '[^A-Za-z0-9]', '', 'g')) = ${key}`,
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  /**
   * Creates the conference with everything it starts with: the creator as its chair, the default
   * decision labels and an empty CFP.
   */
  async create(tx: Executor, values: ConferenceInsert): Promise<ConferenceRow> {
    const [conference] = await tx
      .insert(conferences)
      .values(values)
      .returning();
    await tx.insert(conferenceMembers).values({
      conferenceId: conference.id,
      userId: conference.createdBy,
      role: 'chair',
      status: 'active',
      invitedBy: conference.createdBy,
      respondedAt: new Date(),
    });
    await tx.insert(decisionTypes).values(
      DEFAULT_DECISION_TYPES.map(([label, color, outcome], position) => ({
        conferenceId: conference.id,
        label,
        color,
        outcome,
        position,
      })),
    );
    await tx.insert(cfps).values({ conferenceId: conference.id });
    return conference;
  }

  async update(
    tx: Executor,
    id: string,
    values: Partial<ConferenceInsert>,
  ): Promise<void> {
    await tx.update(conferences).set(values).where(eq(conferences.id, id));
  }

  /** Changes the status only if it is still `from`; false when it wasn't. */
  async moveStatus(
    tx: Executor,
    id: string,
    from: ConferenceRow['status'],
    values: Partial<ConferenceInsert> & { status: ConferenceRow['status'] },
  ): Promise<boolean> {
    const rows = await tx
      .update(conferences)
      .set(values)
      .where(and(eq(conferences.id, id), eq(conferences.status, from)))
      .returning({ id: conferences.id });
    return rows.length > 0;
  }

  /** Locks the row for the rest of the transaction (settings are merged read-modify-write). */
  async lockForUpdate(
    tx: Executor,
    id: string,
  ): Promise<ConferenceRow | undefined> {
    const [row] = await tx
      .select()
      .from(conferences)
      .where(eq(conferences.id, id))
      .for('update');
    return row;
  }

  /**
   * Every conference the user created, is on the team of (not removed), or wrote a paper for,
   * with their active roles.
   */
  listForUser(tx: Executor, userId: string): Promise<MyConferenceRow[]> {
    const authored = sql<boolean>`exists (
      select 1 from ${submissions}
      where ${submissions.conferenceId} = ${conferences.id}
        and (${submissions.submitterId} = ${userId} or ${submissions.id} in (
          select ${submissionAuthors.submissionId} from ${submissionAuthors}
          where ${submissionAuthors.userId} = ${userId})))`;
    const teamMember = sql<boolean>`exists (
      select 1 from ${conferenceMembers}
      where ${conferenceMembers.conferenceId} = ${conferences.id}
        and ${conferenceMembers.userId} = ${userId}
        and ${conferenceMembers.status} <> 'removed')`;
    return tx
      .select({
        ...withCfp,
        activeRoles: sql<string[]>`coalesce((
          select array_agg(distinct ${conferenceMembers.role}::text)
          from ${conferenceMembers}
          where ${conferenceMembers.conferenceId} = ${conferences.id}
            and ${conferenceMembers.userId} = ${userId}
            and ${conferenceMembers.status} = 'active'), '{}')`,
        isAuthor: authored,
      })
      .from(conferences)
      .leftJoin(cfps, eq(cfps.conferenceId, conferences.id))
      .where(
        and(
          ne(conferences.status, 'deleted'),
          or(eq(conferences.createdBy, userId), teamMember, authored),
        ),
      )
      .orderBy(desc(conferences.createdAt));
  }

  /** The latest deletion request per conference that wasn't taken back. */
  async latestDeletionRequests(
    tx: Executor,
    conferenceIds: string[],
  ): Promise<Map<string, DeletionRequestRow>> {
    if (conferenceIds.length === 0) {
      return new Map();
    }
    const rows = await tx
      .select()
      .from(conferenceDeletionRequests)
      .where(
        and(
          inArray(conferenceDeletionRequests.conferenceId, conferenceIds),
          ne(conferenceDeletionRequests.status, 'cancelled'),
        ),
      )
      .orderBy(desc(conferenceDeletionRequests.createdAt));
    const latest = new Map<string, DeletionRequestRow>();
    for (const row of rows) {
      if (!latest.has(row.conferenceId)) {
        latest.set(row.conferenceId, row);
      }
    }
    return latest;
  }

  /** Active conferences with a published CFP that haven't ended (the public directory). */
  listPublished(tx: Executor, today: string) {
    return tx
      .select({
        ...getTableColumns(conferences),
        publishedAt: cfps.decidedAt,
      })
      .from(conferences)
      .innerJoin(cfps, eq(cfps.conferenceId, conferences.id))
      .where(
        and(
          eq(conferences.status, 'active'),
          eq(cfps.status, 'published'),
          or(isNull(conferences.endDate), gte(conferences.endDate, today)),
        ),
      )
      .orderBy(
        sql`${conferences.submissionDeadline} asc nulls last`,
        asc(conferences.startDate),
      );
  }

  /**
   * The conference whose Call for Papers has `page` as its page address (kept in the CFP's content as publicSlug, compared without
   * regard to case). Only an approved conference with a published or closed CFP has a public page.
   */
  async findByCfpPage(tx: Executor, page: string) {
    const [row] = await tx
      .select({
        conference: getTableColumns(conferences),
        content: cfps.content,
        theme: cfps.theme,
        cfpStatus: cfps.status,
      })
      .from(conferences)
      .innerJoin(cfps, eq(cfps.conferenceId, conferences.id))
      .where(
        and(
          eq(conferences.status, 'active'),
          inArray(cfps.status, ['published', 'closed']),
          sql`lower(${cfps.content}->>'publicSlug') = ${page.toLowerCase()}`,
        ),
      )
      .limit(1);
    return row;
  }

  /** Whether another conference's CFP already uses this page address (any status, without regard to case). */
  async cfpPageTaken(
    tx: Executor,
    page: string,
    exceptConferenceId: string,
  ): Promise<boolean> {
    const [row] = await tx
      .select({ id: cfps.conferenceId })
      .from(cfps)
      .where(
        and(
          ne(cfps.conferenceId, exceptConferenceId),
          sql`lower(${cfps.content}->>'publicSlug') = ${page.toLowerCase()}`,
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  // CFP --------------------------------------------------------------------------------------

  async findCfp(tx: Executor, conferenceId: string): Promise<CfpRow> {
    // Every conference has its CFP row; create one for any made before that rule.
    await tx.insert(cfps).values({ conferenceId }).onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(cfps)
      .where(eq(cfps.conferenceId, conferenceId));
    return row;
  }

  async updateCfp(
    tx: Executor,
    conferenceId: string,
    values: Partial<typeof cfps.$inferInsert>,
  ): Promise<CfpRow> {
    await this.findCfp(tx, conferenceId);
    const [row] = await tx
      .update(cfps)
      .set(values)
      .where(eq(cfps.conferenceId, conferenceId))
      .returning();
    return row;
  }

  /** Moves a CFP that waits for approval; undefined when it is no longer waiting. */
  async decideCfp(
    tx: Executor,
    conferenceId: string,
    values: Partial<typeof cfps.$inferInsert>,
  ): Promise<CfpRow | undefined> {
    const [row] = await tx
      .update(cfps)
      .set(values)
      .where(
        and(eq(cfps.conferenceId, conferenceId), eq(cfps.status, 'in_review')),
      )
      .returning();
    return row;
  }

  // Approval ---------------------------------------------------------------------------------

  /** The conference gets its own copy of every platform email template when it goes live. */
  async copyEmailTemplates(tx: Executor, conferenceId: string): Promise<void> {
    await tx
      .insert(conferenceEmailTemplates)
      .select(
        tx
          .select({
            conferenceId: sql<string>`${conferenceId}::uuid`.as(
              'conference_id',
            ),
            key: emailTemplates.key,
            label: emailTemplates.label,
            enabled: sql<boolean>`true`.as('enabled'),
            subject: emailTemplates.subject,
            body: emailTemplates.body,
            isCustom: sql<boolean>`false`.as('is_custom'),
            updatedBy: sql<string | null>`null::uuid`.as('updated_by'),
            updatedAt: sql<Date>`now()`.as('updated_at'),
          })
          .from(emailTemplates)
          // The decision emails belong to the platform; a conference doesn't get a copy.
          .where(notInArray(emailTemplates.key, [...DECISION_TEMPLATE_KEYS])),
      )
      .onConflictDoNothing();
  }

  /** Every conference for the super admin, newest first, with who asked for it. */
  listAll(
    tx: Executor,
    status?: ConferenceRow['status'],
    cfpState?: CfpRow['status'],
  ) {
    return tx
      .select({
        ...withCfp,
        requesterEmail: users.email,
        requesterFirstName: profiles.firstName,
        requesterLastName: profiles.lastName,
        requesterAffiliation: profiles.affiliation,
      })
      .from(conferences)
      .leftJoin(cfps, eq(cfps.conferenceId, conferences.id))
      .innerJoin(users, eq(users.id, conferences.createdBy))
      .leftJoin(profiles, eq(profiles.id, conferences.createdBy))
      .where(
        and(
          status ? eq(conferences.status, status) : undefined,
          cfpState ? eq(cfps.status, cfpState) : undefined,
        ),
      )
      .orderBy(desc(conferences.createdAt));
  }

  // Deletion requests ------------------------------------------------------------------------

  async insertDeletionRequest(
    tx: Executor,
    values: typeof conferenceDeletionRequests.$inferInsert,
  ): Promise<DeletionRequestRow> {
    const [row] = await tx
      .insert(conferenceDeletionRequests)
      .values(values)
      .returning();
    return row;
  }

  /** Closes the pending request of a conference; returns it, or undefined if none was pending. */
  async closePendingDeletionRequest(
    tx: Executor,
    where: { conferenceId: string } | { id: string },
    values: Partial<typeof conferenceDeletionRequests.$inferInsert>,
  ): Promise<DeletionRequestRow | undefined> {
    const [row] = await tx
      .update(conferenceDeletionRequests)
      .set({ decidedAt: new Date(), ...values })
      .where(
        and(
          'id' in where
            ? eq(conferenceDeletionRequests.id, where.id)
            : eq(conferenceDeletionRequests.conferenceId, where.conferenceId),
          eq(conferenceDeletionRequests.status, 'pending'),
        ),
      )
      .returning();
    return row;
  }

  /** Who asked for the conference's deletion that was approved last. */
  async lastApprovedDeletionRequester(
    tx: Executor,
    conferenceId: string,
  ): Promise<string | undefined> {
    const [row] = await tx
      .select({ requestedBy: conferenceDeletionRequests.requestedBy })
      .from(conferenceDeletionRequests)
      .where(
        and(
          eq(conferenceDeletionRequests.conferenceId, conferenceId),
          eq(conferenceDeletionRequests.status, 'approved'),
        ),
      )
      .orderBy(sql`${conferenceDeletionRequests.decidedAt} desc nulls last`)
      .limit(1);
    return row?.requestedBy;
  }

  listDeletionRequests(tx: Executor, status?: string) {
    return tx
      .select({
        ...getTableColumns(conferenceDeletionRequests),
        acronym: conferences.acronym,
        title: conferences.title,
        requesterEmail: users.email,
        requesterFirstName: profiles.firstName,
        requesterLastName: profiles.lastName,
      })
      .from(conferenceDeletionRequests)
      .innerJoin(
        conferences,
        eq(conferences.id, conferenceDeletionRequests.conferenceId),
      )
      .innerJoin(users, eq(users.id, conferenceDeletionRequests.requestedBy))
      .leftJoin(
        profiles,
        eq(profiles.id, conferenceDeletionRequests.requestedBy),
      )
      .where(status ? eq(conferenceDeletionRequests.status, status) : undefined)
      .orderBy(desc(conferenceDeletionRequests.createdAt));
  }
}
