import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import type { Executor } from '../../core/database/database.types.js';
import {
  conferenceMembers,
  conferences,
  profileDetails,
  profiles,
  reviewAssignments,
  reviews,
  submissionAuthors,
  submissions,
  users,
} from '../../core/database/schema/index.js';

export type ProfileRow = typeof profiles.$inferSelect & {
  email: string | null;
  emailVerifiedAt: Date | null;
  isSuperAdmin: boolean;
  termsAcceptedAt: Date | null;
  termsVersion: string | null;
  /** False for accounts created through Google, Microsoft or ORCID that never set a password. */
  hasPassword: boolean;
};
export type ProfileUpdate = Partial<
  Pick<
    typeof profiles.$inferInsert,
    | 'firstName'
    | 'lastName'
    | 'designation'
    | 'affiliation'
    | 'country'
    | 'orcidId'
    | 'photoPath'
  >
>;

/** Database access for the users module. Pass a transaction to make a call part of it. */
@Injectable()
export class UsersRepository {
  async findProfile(
    tx: Executor,
    userId: string,
  ): Promise<ProfileRow | undefined> {
    const [row] = await tx
      .select({
        ...getTableColumns(profiles),
        email: users.email,
        emailVerifiedAt: users.emailVerifiedAt,
        isSuperAdmin: users.isSuperAdmin,
        termsAcceptedAt: users.termsAcceptedAt,
        termsVersion: users.termsVersion,
        hasPassword: sql<boolean>`${users.passwordHash} is not null`,
      })
      .from(profiles)
      .innerJoin(users, eq(users.id, profiles.id))
      .where(eq(profiles.id, userId));
    return row;
  }

  async findDetails(
    tx: Executor,
    userId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const [row] = await tx
      .select({ data: profileDetails.data })
      .from(profileDetails)
      .where(eq(profileDetails.userId, userId));
    return row?.data as Record<string, unknown> | undefined;
  }

  /** Returns false if no row was updated (the profile does not exist). */
  async updateProfile(
    tx: Executor,
    userId: string,
    values: ProfileUpdate,
  ): Promise<boolean> {
    const rows = await tx
      .update(profiles)
      .set(values)
      .where(eq(profiles.id, userId))
      .returning({ id: profiles.id });
    return rows.length > 0;
  }

  async updateDetails(
    tx: Executor,
    userId: string,
    data: Record<string, unknown>,
  ): Promise<boolean> {
    const rows = await tx
      .update(profileDetails)
      .set({ data })
      .where(eq(profileDetails.userId, userId))
      .returning({ userId: profileDetails.userId });
    return rows.length > 0;
  }

  /** Records that the user accepted `version` of the Terms, now. */
  async acceptTerms(
    tx: Executor,
    userId: string,
    version: string,
  ): Promise<void> {
    await tx
      .update(users)
      .set({ termsVersion: version, termsAcceptedAt: new Date() })
      .where(eq(users.id, userId));
  }

  listConferences(tx: Executor, userId: string) {
    return tx
      .select({
        conferenceId: conferences.id,
        slug: conferences.slug,
        acronym: conferences.acronym,
        title: conferences.title,
        conferenceStatus: conferences.status,
        role: conferenceMembers.role,
        memberStatus: conferenceMembers.status,
      })
      .from(conferenceMembers)
      .innerJoin(
        conferences,
        eq(conferences.id, conferenceMembers.conferenceId),
      )
      .where(
        and(
          eq(conferenceMembers.userId, userId),
          ne(conferenceMembers.status, 'removed'),
        ),
      )
      .orderBy(asc(conferences.acronym), asc(conferenceMembers.role));
  }

  // Dashboard ---------------------------------------------------------------------------------

  /** Every non-removed membership of the user, with its conference (deleted conferences left out). */
  dashboardMemberships(tx: Executor, userId: string) {
    return tx
      .select({
        memberId: conferenceMembers.id,
        conferenceId: conferenceMembers.conferenceId,
        role: conferenceMembers.role,
        status: conferenceMembers.status,
        maxPapers: conferenceMembers.maxPapers,
        invitedAt: conferenceMembers.invitedAt,
        respondedAt: conferenceMembers.respondedAt,
        declineReason: conferenceMembers.declineReason,
        slug: conferences.slug,
        acronym: conferences.acronym,
        title: conferences.title,
        country: conferences.country,
        conferenceStatus: conferences.status,
      })
      .from(conferenceMembers)
      .innerJoin(
        conferences,
        eq(conferences.id, conferenceMembers.conferenceId),
      )
      .where(
        and(
          eq(conferenceMembers.userId, userId),
          ne(conferenceMembers.status, 'removed'),
          isNull(conferences.deletedAt),
        ),
      )
      .orderBy(asc(conferences.acronym));
  }

  /** Papers the user submitted or is listed on as an author. */
  dashboardAuthorPapers(tx: Executor, userId: string) {
    const listedAsAuthor = tx
      .select({ id: submissionAuthors.submissionId })
      .from(submissionAuthors)
      .where(eq(submissionAuthors.userId, userId));
    return tx
      .select({
        submissionId: submissions.id,
        conferenceId: submissions.conferenceId,
        paperNo: submissions.paperNo,
        status: submissions.status,
        notifiedOutcome: submissions.notifiedOutcome,
      })
      .from(submissions)
      .where(
        or(
          eq(submissions.submitterId, userId),
          inArray(submissions.id, listedAsAuthor),
        ),
      )
      .orderBy(asc(submissions.conferenceId), asc(submissions.paperNo));
  }

  /** All papers of the given conferences (the ones the user chairs). */
  async dashboardChairPapers(tx: Executor, conferenceIds: string[]) {
    if (conferenceIds.length === 0) return [];
    return tx
      .select({
        submissionId: submissions.id,
        conferenceId: submissions.conferenceId,
        status: submissions.status,
        outcome: submissions.outcome,
      })
      .from(submissions)
      .where(inArray(submissions.conferenceId, conferenceIds))
      .orderBy(asc(submissions.conferenceId), asc(submissions.paperNo));
  }

  /** Papers assigned to the user as a reviewer, with whether their review is submitted. */
  dashboardAssignments(tx: Executor, userId: string) {
    return tx
      .select({
        assignmentId: reviewAssignments.id,
        submissionId: reviewAssignments.submissionId,
        conferenceId: submissions.conferenceId,
        paperNo: submissions.paperNo,
        status: reviewAssignments.status,
        dueAt: reviewAssignments.dueAt,
        reviewStatus: reviews.status,
      })
      .from(reviewAssignments)
      .innerJoin(
        submissions,
        eq(submissions.id, reviewAssignments.submissionId),
      )
      .leftJoin(reviews, eq(reviews.assignmentId, reviewAssignments.id))
      .where(
        and(
          eq(reviewAssignments.reviewerId, userId),
          ne(reviewAssignments.status, 'removed'),
        ),
      )
      .orderBy(asc(submissions.conferenceId), asc(submissions.paperNo));
  }

  /** Conference rows for the dashboard (only active or archived ones are shown). */
  async dashboardConferences(tx: Executor, ids: string[]) {
    if (ids.length === 0) return [];
    return tx
      .select({
        conferenceId: conferences.id,
        slug: conferences.slug,
        acronym: conferences.acronym,
        title: conferences.title,
        status: conferences.status,
        logoPath: conferences.logoPath,
        city: conferences.city,
        country: conferences.country,
        startDate: conferences.startDate,
        endDate: conferences.endDate,
        reviewDeadline: conferences.reviewDeadline,
      })
      .from(conferences)
      .where(
        and(
          inArray(conferences.id, ids),
          inArray(conferences.status, ['active', 'archived']),
          isNull(conferences.deletedAt),
        ),
      )
      .orderBy(asc(conferences.acronym));
  }
}
