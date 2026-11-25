import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import type { Executor, Tx } from '../../core/database/database.types.js';
import {
  cfps,
  conferences,
  decisionEvents,
  decisionTypes,
  reviewAssignments,
  submissionAuthors,
  submissionFiles,
  submissionRegistrations,
  submissions,
  users,
} from '../../core/database/schema/index.js';

export type SubmissionRow = typeof submissions.$inferSelect;
export type AuthorRow = typeof submissionAuthors.$inferSelect;
export type FileRow = typeof submissionFiles.$inferSelect;
export type RegistrationRow = typeof submissionRegistrations.$inferSelect;
export type RegistrationValues = Pick<
  RegistrationRow,
  'payment' | 'attendance' | 'presenterEmail' | 'note'
>;

export interface ConferenceInfo {
  id: string;
  slug: string;
  acronym: string;
  title: string;
  contactEmail: string | null;
  submissionDeadline: Date | null;
  reviewMode: (typeof conferences.$inferSelect)['reviewMode'];
  cfpStatus: (typeof cfps.$inferSelect)['status'];
}

export interface NewAuthor {
  name: string;
  email: string;
  affiliation: string | null;
  country: string | null;
  corresponding: boolean;
}

/** What a paper needs to be shown: the row, its authors, its files and its registration (if recorded). */
export interface PaperBundle {
  submission: SubmissionRow;
  authors: AuthorRow[];
  files: FileRow[];
  registration: RegistrationRow | null;
}

const lowerEmail = (email: string) => email.trim().toLowerCase();

@Injectable()
export class SubmissionsRepository {
  async conferenceInfo(
    executor: Executor,
    conferenceId: string,
  ): Promise<ConferenceInfo | undefined> {
    const [row] = await executor
      .select({
        id: conferences.id,
        slug: conferences.slug,
        acronym: conferences.acronym,
        title: conferences.title,
        contactEmail: conferences.contactEmail,
        submissionDeadline: conferences.submissionDeadline,
        reviewMode: conferences.reviewMode,
        cfpStatus: sql<
          ConferenceInfo['cfpStatus']
        >`coalesce(${cfps.status}, 'draft')`,
      })
      .from(conferences)
      .leftJoin(cfps, eq(cfps.conferenceId, conferences.id))
      .where(eq(conferences.id, conferenceId));
    return row;
  }

  /** The next paper number of the conference (locks the counter until the transaction ends). */
  async registration(
    executor: Executor,
    submissionId: string,
  ): Promise<RegistrationRow | undefined> {
    const [row] = await executor
      .select()
      .from(submissionRegistrations)
      .where(eq(submissionRegistrations.submissionId, submissionId));
    return row;
  }

  async saveRegistration(
    tx: Tx,
    submissionId: string,
    values: RegistrationValues,
    updatedBy: string,
  ): Promise<void> {
    const row = { ...values, updatedBy, updatedAt: new Date() };
    await tx
      .insert(submissionRegistrations)
      .values({ submissionId, ...row })
      .onConflictDoUpdate({
        target: submissionRegistrations.submissionId,
        set: row,
      });
  }

  async nextPaperNo(tx: Tx, conferenceId: string): Promise<number> {
    const [row] = await tx
      .update(conferences)
      .set({ nextPaperNo: sql`${conferences.nextPaperNo} + 1` })
      .where(eq(conferences.id, conferenceId))
      .returning({ paperNo: sql<number>`${conferences.nextPaperNo} - 1` });
    return row.paperNo;
  }

  async insert(
    tx: Tx,
    values: typeof submissions.$inferInsert,
  ): Promise<SubmissionRow> {
    const [row] = await tx.insert(submissions).values(values).returning();
    return row;
  }

  async findForUpdate(
    tx: Tx,
    submissionId: string,
  ): Promise<SubmissionRow | undefined> {
    const [row] = await tx
      .select()
      .from(submissions)
      .where(eq(submissions.id, submissionId))
      .for('update');
    return row;
  }

  /** The papers among `ids` that belong to the conference (drafts are not papers yet). */
  async idsInConference(
    tx: Tx,
    conferenceId: string,
    ids: readonly string[],
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await tx
      .select({ id: submissions.id })
      .from(submissions)
      .where(
        and(
          eq(submissions.conferenceId, conferenceId),
          inArray(submissions.id, [...ids]),
        ),
      );
    return rows.map((r) => r.id);
  }

  async setTrack(tx: Tx, ids: readonly string[], track: string): Promise<void> {
    await tx
      .update(submissions)
      .set({
        details: sql`${submissions.details} || ${JSON.stringify({ track })}::jsonb`,
      })
      .where(inArray(submissions.id, [...ids]));
  }

  async deleteMany(tx: Tx, ids: readonly string[]): Promise<void> {
    await tx.delete(submissions).where(inArray(submissions.id, [...ids]));
  }

  async update(
    tx: Tx,
    submissionId: string,
    values: Partial<typeof submissions.$inferInsert>,
  ): Promise<SubmissionRow> {
    const [row] = await tx
      .update(submissions)
      .set(values)
      .where(eq(submissions.id, submissionId))
      .returning();
    return row;
  }

  /** Account ids for these emails (active accounts), keyed by lower-case email. */
  async accountsByEmail(
    executor: Executor,
    emails: readonly string[],
  ): Promise<Map<string, string>> {
    const addresses = [...new Set(emails.map(lowerEmail))];
    if (addresses.length === 0) {
      return new Map();
    }
    const rows = await executor
      .select({ id: users.id, email: sql<string>`lower(${users.email})` })
      .from(users)
      .where(inArray(sql`lower(${users.email})`, addresses));
    return new Map(rows.map((r) => [r.email, r.id]));
  }

  async authors(
    executor: Executor,
    submissionId: string,
  ): Promise<AuthorRow[]> {
    return executor
      .select()
      .from(submissionAuthors)
      .where(eq(submissionAuthors.submissionId, submissionId))
      .orderBy(asc(submissionAuthors.position));
  }

  /**
   * Replaces the author list. Authors whose email stays are updated in place (their account link
   * is kept); removed ones are deleted; new ones are inserted and linked to an account with that
   * email. Returns the authors that are new to the paper.
   */
  async replaceAuthors(
    tx: Tx,
    submissionId: string,
    authors: readonly NewAuthor[],
  ): Promise<AuthorRow[]> {
    const current = await this.authors(tx, submissionId);
    const byEmail = new Map(current.map((a) => [lowerEmail(a.email), a]));
    const keep = new Set(authors.map((a) => lowerEmail(a.email)));
    const gone = current.filter((a) => !keep.has(lowerEmail(a.email)));
    if (gone.length > 0) {
      await tx.delete(submissionAuthors).where(
        inArray(
          submissionAuthors.id,
          gone.map((a) => a.id),
        ),
      );
    }
    const accounts = await this.accountsByEmail(
      tx,
      authors
        .filter((a) => !byEmail.has(lowerEmail(a.email)))
        .map((a) => a.email),
    );
    const added: AuthorRow[] = [];
    for (const [position, author] of authors.entries()) {
      const fields = {
        position,
        name: author.name,
        email: author.email,
        affiliation: author.affiliation,
        country: author.country,
        isCorresponding: author.corresponding,
      };
      const existing = byEmail.get(lowerEmail(author.email));
      if (existing) {
        await tx
          .update(submissionAuthors)
          .set(fields)
          .where(eq(submissionAuthors.id, existing.id));
      } else {
        const [row] = await tx
          .insert(submissionAuthors)
          .values({
            submissionId,
            ...fields,
            userId: accounts.get(lowerEmail(author.email)) ?? null,
          })
          .returning();
        added.push(row);
      }
    }
    return added;
  }

  async files(
    executor: Executor,
    submissionIds: readonly string[],
  ): Promise<FileRow[]> {
    if (submissionIds.length === 0) {
      return [];
    }
    return executor
      .select()
      .from(submissionFiles)
      .where(inArray(submissionFiles.submissionId, [...submissionIds]))
      .orderBy(asc(submissionFiles.uploadedAt));
  }

  /** Papers with their authors and files, in paper-number order. */
  async bundles(
    executor: Executor,
    where: ReturnType<typeof and>,
  ): Promise<PaperBundle[]> {
    const rows = await executor
      .select()
      .from(submissions)
      .where(where)
      .orderBy(asc(submissions.conferenceId), asc(submissions.paperNo));
    const ids = rows.map((r) => r.id);
    const [authors, files, registrations] = await Promise.all([
      ids.length === 0
        ? []
        : executor
            .select()
            .from(submissionAuthors)
            .where(inArray(submissionAuthors.submissionId, ids))
            .orderBy(asc(submissionAuthors.position)),
      this.files(executor, ids),
      ids.length === 0
        ? []
        : executor
            .select()
            .from(submissionRegistrations)
            .where(inArray(submissionRegistrations.submissionId, ids)),
    ]);
    return rows.map((submission) => ({
      submission,
      authors: authors.filter((a) => a.submissionId === submission.id),
      files: files.filter((f) => f.submissionId === submission.id),
      registration:
        registrations.find((r) => r.submissionId === submission.id) ?? null,
    }));
  }

  async bundle(
    executor: Executor,
    submissionId: string,
  ): Promise<PaperBundle | undefined> {
    const [bundle] = await this.bundles(
      executor,
      eq(submissions.id, submissionId),
    );
    return bundle;
  }

  /** Every paper of a conference (chairs). */
  conferencePapers(executor: Executor, conferenceId: string) {
    return this.bundles(executor, eq(submissions.conferenceId, conferenceId));
  }

  /** Papers the user submitted or co-authors, optionally in one conference. */
  authoredPapers(executor: Executor, userId: string, conferenceId?: string) {
    const mine = or(
      eq(submissions.submitterId, userId),
      inArray(
        submissions.id,
        executor
          .select({ id: submissionAuthors.submissionId })
          .from(submissionAuthors)
          .where(eq(submissionAuthors.userId, userId)),
      ),
    );
    return this.bundles(
      executor,
      conferenceId
        ? and(eq(submissions.conferenceId, conferenceId), mine)
        : and(mine),
    );
  }

  /** Papers of a conference given to the user to review (assignment not declined or removed). */
  assignedPapers(executor: Executor, userId: string, conferenceId: string) {
    return this.bundles(
      executor,
      and(
        eq(submissions.conferenceId, conferenceId),
        inArray(
          submissions.id,
          executor
            .select({ id: reviewAssignments.submissionId })
            .from(reviewAssignments)
            .where(
              and(
                eq(reviewAssignments.reviewerId, userId),
                inArray(reviewAssignments.status, [
                  'assigned',
                  'accepted',
                  'submitted',
                ]),
              ),
            ),
        ),
      ),
    );
  }

  /** Conferences (id → slug, acronym) for a set of papers. */
  async conferenceLabels(
    executor: Executor,
    conferenceIds: readonly string[],
  ): Promise<Map<string, { slug: string; acronym: string }>> {
    const ids = [...new Set(conferenceIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await executor
      .select({
        id: conferences.id,
        slug: conferences.slug,
        acronym: conferences.acronym,
      })
      .from(conferences)
      .where(inArray(conferences.id, ids));
    return new Map(rows.map((r) => [r.id, r]));
  }

  /**
   * Is a paper with this title (ignoring case, spaces and punctuation) already in the conference,
   * and is the user one of its authors? Withdrawn papers don't count.
   */
  async duplicate(
    executor: Executor,
    conferenceId: string,
    title: string,
    userId: string,
  ): Promise<{ found: boolean; mine: boolean }> {
    const normalized = title.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (normalized === '') {
      return { found: false, mine: false };
    }
    const hits = await executor
      .select({ id: submissions.id, submitterId: submissions.submitterId })
      .from(submissions)
      .where(
        and(
          eq(submissions.conferenceId, conferenceId),
          ne(submissions.status, 'withdrawn'),
          sql`regexp_replace(lower(${submissions.title}), '[^a-z0-9]+', '', 'g') = ${normalized}`,
        ),
      );
    if (hits.length === 0) {
      return { found: false, mine: false };
    }
    if (hits.some((h) => h.submitterId === userId)) {
      return { found: true, mine: true };
    }
    const [coAuthored] = await executor
      .select({ id: submissionAuthors.id })
      .from(submissionAuthors)
      .where(
        and(
          inArray(
            submissionAuthors.submissionId,
            hits.map((h) => h.id),
          ),
          eq(submissionAuthors.userId, userId),
        ),
      )
      .limit(1);
    return { found: true, mine: coAuthored !== undefined };
  }

  /** Takes the paper out of reviewers' queues (sent reviews stay on record). */
  async removeOpenAssignments(tx: Tx, submissionId: string): Promise<void> {
    await tx
      .update(reviewAssignments)
      .set({ status: 'removed' })
      .where(
        and(
          eq(reviewAssignments.submissionId, submissionId),
          inArray(reviewAssignments.status, ['assigned', 'accepted']),
        ),
      );
  }

  /** Linked accounts of the paper: the submitter and co-authors with an account. */
  async linkedUserIds(
    executor: Executor,
    submissionId: string,
  ): Promise<string[]> {
    const [row] = await executor
      .select({ submitterId: submissions.submitterId })
      .from(submissions)
      .where(eq(submissions.id, submissionId));
    const authors = await executor
      .select({ userId: submissionAuthors.userId })
      .from(submissionAuthors)
      .where(
        and(
          eq(submissionAuthors.submissionId, submissionId),
          isNotNull(submissionAuthors.userId),
        ),
      );
    return [
      ...new Set([
        ...(row ? [row.submitterId] : []),
        ...authors.map((a) => a.userId!),
      ]),
    ];
  }

  async decisionType(
    executor: Executor,
    conferenceId: string,
    decisionTypeId: string,
  ) {
    const [row] = await executor
      .select()
      .from(decisionTypes)
      .where(
        and(
          eq(decisionTypes.id, decisionTypeId),
          eq(decisionTypes.conferenceId, conferenceId),
        ),
      );
    return row;
  }

  async insertDecisionEvent(
    tx: Tx,
    values: typeof decisionEvents.$inferInsert,
  ): Promise<void> {
    await tx.insert(decisionEvents).values(values);
  }

  // Screening settings and files ----------------------------------------------------------------

  /** The conference's settings (the screening config lives under `screening`). */
  async conferenceSettings(
    executor: Executor,
    conferenceId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const [row] = await executor
      .select({ settings: conferences.settings })
      .from(conferences)
      .where(eq(conferences.id, conferenceId));
    return row?.settings as Record<string, unknown> | undefined;
  }

  async saveScreeningConfig(
    tx: Tx,
    conferenceId: string,
    config: { settings: object; criteria: object },
  ): Promise<void> {
    await tx
      .update(conferences)
      .set({
        settings: sql`coalesce(${conferences.settings}, '{}'::jsonb) || jsonb_build_object('screening', ${JSON.stringify(config)}::jsonb)`,
      })
      .where(eq(conferences.id, conferenceId));
  }

  /** How many paper versions (not supplementary files) the paper has. */
  async paperVersionCount(
    executor: Executor,
    submissionId: string,
  ): Promise<number> {
    const [row] = await executor
      .select({ count: sql<number>`count(*)::int` })
      .from(submissionFiles)
      .where(
        and(
          eq(submissionFiles.submissionId, submissionId),
          ne(submissionFiles.kind, 'supplementary'),
        ),
      );
    return row?.count ?? 0;
  }

  async insertFile(
    tx: Tx,
    values: typeof submissionFiles.$inferInsert,
  ): Promise<FileRow> {
    const [row] = await tx.insert(submissionFiles).values(values).returning();
    return row;
  }

  async fileById(
    executor: Executor,
    fileId: string,
  ): Promise<FileRow | undefined> {
    const [row] = await executor
      .select()
      .from(submissionFiles)
      .where(eq(submissionFiles.id, fileId));
    return row;
  }

  async saveAutoCheck(
    executor: Executor,
    fileId: string,
    autoCheck: Record<string, unknown>,
  ): Promise<void> {
    await executor
      .update(submissionFiles)
      .set({ autoCheck })
      .where(eq(submissionFiles.id, fileId));
  }

  /** The decision type of an outcome in the conference (its first, by position). */
  async decisionTypeFor(
    executor: Executor,
    conferenceId: string,
    outcome: (typeof decisionTypes.$inferSelect)['outcome'],
  ) {
    const [row] = await executor
      .select()
      .from(decisionTypes)
      .where(
        and(
          eq(decisionTypes.conferenceId, conferenceId),
          eq(decisionTypes.outcome, outcome),
        ),
      )
      .orderBy(asc(decisionTypes.position))
      .limit(1);
    return row;
  }

  /**
   * The newest paper version of each paper in the conference that has a result from the app's
   * automatic check but no initial check decision yet: what AI mode decides when turned on.
   */
  async checkedVersionsWaiting(
    tx: Tx,
    conferenceId: string,
  ): Promise<string[]> {
    const rows = await tx.execute<{ id: string }>(sql`
      select f.id from (
        select f.id, f.submission_id, f.auto_check,
               row_number() over (partition by f.submission_id order by f.version desc, f.uploaded_at desc) as newest,
               count(*) over (partition by f.submission_id) as versions
          from ${submissionFiles} f
         where f.kind <> 'supplementary'
      ) f
      join ${submissions} s on s.id = f.submission_id
      where f.newest = 1 and f.auto_check is not null
        and s.conference_id = ${conferenceId} and s.status = 'submitted'
        and coalesce(s.screening -> (f.versions::text) -> 'check' ->> 'decision', 'pending') = 'pending'`);
    return [...rows].map((r) => r.id);
  }

  /**
   * Ids of the papers whose paper id reads `<prefix>-<paperNo>` ("ICX-12"). The prefix is the first
   * word of the conference acronym, letters and digits only (see paperPrefix); two conferences can
   * share a prefix, so the caller checks which one the user may see.
   */
  async idsByLabel(
    executor: Executor,
    prefix: string,
    paperNo: number,
  ): Promise<string[]> {
    const rows = await executor
      .select({ id: submissions.id })
      .from(submissions)
      .innerJoin(conferences, eq(conferences.id, submissions.conferenceId))
      .where(
        and(
          eq(submissions.paperNo, paperNo),
          sql`upper(regexp_replace(split_part(${conferences.acronym}, ' ', 1), '[^A-Za-z0-9]', '', 'g')) = ${prefix.toUpperCase()}`,
        ),
      );
    return rows.map((r) => r.id);
  }
}
