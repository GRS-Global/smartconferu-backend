import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { Executor, Tx } from '../../core/database/database.types.js';
import {
  conferenceMembers,
  conferences,
  decisionTypes,
  pendingReviewAssignments,
  profiles,
  reviewAssignments,
  reviews,
  submissionAuthors,
  submissions,
  users,
} from '../../core/database/schema/index.js';

export type AssignmentRow = typeof reviewAssignments.$inferSelect;
export type ReviewRow = typeof reviews.$inferSelect;
export type PendingRow = typeof pendingReviewAssignments.$inferSelect;
export type MemberRow = typeof conferenceMembers.$inferSelect;
export type DecisionTypeRow = typeof decisionTypes.$inferSelect;

/** An assignment with its reviewer's name and its review. */
export interface AssignmentBundle {
  assignment: AssignmentRow;
  reviewer: { userId: string; name: string; email: string | null };
  review: ReviewRow | null;
}

export interface PendingBundle {
  pending: PendingRow;
  name: string;
  email: string | null;
}

/** Assignments that count: not declined or taken away. */
export const ACTIVE_ASSIGNMENTS = [
  'assigned',
  'accepted',
  'submitted',
] as const;

const personName = sql<string>`coalesce(
  nullif(trim(${profiles.firstName} || ' ' || ${profiles.lastName}), ''),
  ${users.email}, 'Reviewer')`;

@Injectable()
export class ReviewsRepository {
  // Assignments ---------------------------------------------------------------------------------

  async assignmentForUpdate(
    tx: Tx,
    assignmentId: string,
  ): Promise<AssignmentRow | undefined> {
    const [row] = await tx
      .select()
      .from(reviewAssignments)
      .where(eq(reviewAssignments.id, assignmentId))
      .for('update');
    return row;
  }

  async assignmentsOf(
    executor: Executor,
    where: { submissionId?: string; reviewerId?: string; ids?: string[] },
  ): Promise<AssignmentBundle[]> {
    const conditions = [
      where.submissionId
        ? eq(reviewAssignments.submissionId, where.submissionId)
        : undefined,
      where.reviewerId
        ? eq(reviewAssignments.reviewerId, where.reviewerId)
        : undefined,
      where.ids ? inArray(reviewAssignments.id, where.ids) : undefined,
    ].filter((c) => c !== undefined);
    if (where.ids?.length === 0) {
      return [];
    }
    const rows = await executor
      .select({
        assignment: reviewAssignments,
        review: reviews,
        name: personName,
        email: users.email,
      })
      .from(reviewAssignments)
      .innerJoin(users, eq(users.id, reviewAssignments.reviewerId))
      .leftJoin(profiles, eq(profiles.id, users.id))
      .leftJoin(reviews, eq(reviews.assignmentId, reviewAssignments.id))
      .where(and(...conditions))
      .orderBy(asc(reviewAssignments.assignedAt), asc(reviewAssignments.id));
    return rows.map((r) => ({
      assignment: r.assignment,
      review: r.review,
      reviewer: {
        userId: r.assignment.reviewerId,
        name: r.name,
        email: r.email,
      },
    }));
  }

  /** Every assignment of every paper of a conference, with the reviewer's name and the review (the chair's review board). */
  async assignmentsOfConference(
    executor: Executor,
    conferenceId: string,
  ): Promise<AssignmentBundle[]> {
    const rows = await executor
      .select({
        assignment: reviewAssignments,
        review: reviews,
        name: personName,
        email: users.email,
      })
      .from(reviewAssignments)
      .innerJoin(
        submissions,
        eq(submissions.id, reviewAssignments.submissionId),
      )
      .innerJoin(users, eq(users.id, reviewAssignments.reviewerId))
      .leftJoin(profiles, eq(profiles.id, users.id))
      .leftJoin(reviews, eq(reviews.assignmentId, reviewAssignments.id))
      .where(eq(submissions.conferenceId, conferenceId))
      .orderBy(asc(reviewAssignments.assignedAt), asc(reviewAssignments.id));
    return rows.map((r) => ({
      assignment: r.assignment,
      review: r.review,
      reviewer: {
        userId: r.assignment.reviewerId,
        name: r.name,
        email: r.email,
      },
    }));
  }

  /** Papers of a conference waiting for an invited reviewer who has not joined the committee yet. */
  async pendingOfConference(
    executor: Executor,
    conferenceId: string,
  ): Promise<PendingBundle[]> {
    const rows = await executor
      .select({
        pending: pendingReviewAssignments,
        displayName: conferenceMembers.displayName,
        invitedEmail: conferenceMembers.invitedEmail,
        name: sql<
          string | null
        >`nullif(trim(${profiles.firstName} || ' ' || ${profiles.lastName}), '')`,
        email: users.email,
      })
      .from(pendingReviewAssignments)
      .innerJoin(
        submissions,
        eq(submissions.id, pendingReviewAssignments.submissionId),
      )
      .innerJoin(
        conferenceMembers,
        eq(conferenceMembers.id, pendingReviewAssignments.memberId),
      )
      .leftJoin(users, eq(users.id, conferenceMembers.userId))
      .leftJoin(profiles, eq(profiles.id, conferenceMembers.userId))
      .where(eq(submissions.conferenceId, conferenceId))
      .orderBy(asc(pendingReviewAssignments.createdAt));
    return rows.map((r) => ({
      pending: r.pending,
      name:
        r.name ??
        r.displayName ??
        r.invitedEmail ??
        r.email ??
        'Invited reviewer',
      email: r.email ?? r.invitedEmail,
    }));
  }

  /** The ids of a conference's papers that were submitted (not drafts). */
  async submittedPaperIds(
    executor: Executor,
    conferenceId: string,
  ): Promise<string[]> {
    const rows = await executor
      .select({ id: submissions.id })
      .from(submissions)
      .where(
        and(
          eq(submissions.conferenceId, conferenceId),
          ne(submissions.status, 'draft'),
        ),
      )
      .orderBy(asc(submissions.paperNo));
    return rows.map((r) => r.id);
  }

  async assignmentOf(
    executor: Executor,
    assignmentId: string,
  ): Promise<AssignmentBundle | undefined> {
    const [row] = await this.assignmentsOf(executor, { ids: [assignmentId] });
    return row;
  }

  /** The reviewer's own assignment rows on a paper, whatever their state. */
  async existingAssignments(
    tx: Tx,
    submissionId: string,
    reviewerIds: readonly string[],
  ): Promise<AssignmentRow[]> {
    if (reviewerIds.length === 0) {
      return [];
    }
    return tx
      .select()
      .from(reviewAssignments)
      .where(
        and(
          eq(reviewAssignments.submissionId, submissionId),
          inArray(reviewAssignments.reviewerId, [...reviewerIds]),
        ),
      )
      .for('update');
  }

  async insertAssignment(
    tx: Tx,
    values: typeof reviewAssignments.$inferInsert,
  ): Promise<AssignmentRow> {
    const [row] = await tx.insert(reviewAssignments).values(values).returning();
    return row;
  }

  async updateAssignment(
    tx: Tx,
    assignmentId: string,
    values: Partial<typeof reviewAssignments.$inferInsert>,
  ): Promise<AssignmentRow> {
    const [row] = await tx
      .update(reviewAssignments)
      .set(values)
      .where(eq(reviewAssignments.id, assignmentId))
      .returning();
    return row;
  }

  // Waiting assignments (invited reviewers) -------------------------------------------------------

  async pendingOf(
    executor: Executor,
    submissionId: string,
  ): Promise<PendingBundle[]> {
    const rows = await executor
      .select({
        pending: pendingReviewAssignments,
        displayName: conferenceMembers.displayName,
        invitedEmail: conferenceMembers.invitedEmail,
        name: sql<
          string | null
        >`nullif(trim(${profiles.firstName} || ' ' || ${profiles.lastName}), '')`,
        email: users.email,
      })
      .from(pendingReviewAssignments)
      .innerJoin(
        conferenceMembers,
        eq(conferenceMembers.id, pendingReviewAssignments.memberId),
      )
      .leftJoin(users, eq(users.id, conferenceMembers.userId))
      .leftJoin(profiles, eq(profiles.id, conferenceMembers.userId))
      .where(eq(pendingReviewAssignments.submissionId, submissionId))
      .orderBy(asc(pendingReviewAssignments.createdAt));
    return rows.map((r) => ({
      pending: r.pending,
      name:
        r.name ??
        r.displayName ??
        r.invitedEmail ??
        r.email ??
        'Invited reviewer',
      email: r.email ?? r.invitedEmail,
    }));
  }

  async upsertPending(
    tx: Tx,
    values: {
      submissionId: string;
      memberId: string;
      dueAt: Date | null;
      assignedBy: string;
    },
  ): Promise<void> {
    await tx
      .insert(pendingReviewAssignments)
      .values(values)
      .onConflictDoUpdate({
        target: [
          pendingReviewAssignments.submissionId,
          pendingReviewAssignments.memberId,
        ],
        set: { dueAt: values.dueAt, assignedBy: values.assignedBy },
      });
  }

  async pendingById(tx: Tx, pendingId: string) {
    const [row] = await tx
      .select({
        pending: pendingReviewAssignments,
        conferenceId: submissions.conferenceId,
      })
      .from(pendingReviewAssignments)
      .innerJoin(
        submissions,
        eq(submissions.id, pendingReviewAssignments.submissionId),
      )
      .where(eq(pendingReviewAssignments.id, pendingId))
      .for('update', { of: pendingReviewAssignments });
    return row;
  }

  async deletePending(tx: Tx, pendingId: string): Promise<void> {
    await tx
      .delete(pendingReviewAssignments)
      .where(eq(pendingReviewAssignments.id, pendingId));
  }

  // Committee -----------------------------------------------------------------------------------

  async members(
    executor: Executor,
    conferenceId: string,
    memberIds: readonly string[],
  ): Promise<MemberRow[]> {
    return executor
      .select()
      .from(conferenceMembers)
      .where(
        and(
          eq(conferenceMembers.conferenceId, conferenceId),
          inArray(conferenceMembers.id, [...memberIds]),
        ),
      );
  }

  /** Accounts that wrote the paper (the submitter and linked co-authors): they can't review it. */
  async authorAccounts(
    executor: Executor,
    submissionId: string,
  ): Promise<Set<string>> {
    const rows = await executor
      .select({ userId: submissions.submitterId })
      .from(submissions)
      .where(eq(submissions.id, submissionId))
      .union(
        executor
          .select({ userId: sql<string>`${submissionAuthors.userId}` })
          .from(submissionAuthors)
          .where(
            and(
              eq(submissionAuthors.submissionId, submissionId),
              isNotNull(submissionAuthors.userId),
            ),
          ),
      );
    return new Set(rows.map((r) => r.userId));
  }

  // Reviews -------------------------------------------------------------------------------------

  async reviewForAssignment(
    tx: Tx,
    assignmentId: string,
  ): Promise<ReviewRow | undefined> {
    const [row] = await tx
      .select()
      .from(reviews)
      .where(eq(reviews.assignmentId, assignmentId))
      .for('update');
    return row;
  }

  async reviewForUpdate(
    tx: Tx,
    reviewId: string,
  ): Promise<ReviewRow | undefined> {
    const [row] = await tx
      .select()
      .from(reviews)
      .where(eq(reviews.id, reviewId))
      .for('update');
    return row;
  }

  async insertReview(
    tx: Tx,
    values: typeof reviews.$inferInsert,
  ): Promise<ReviewRow> {
    const [row] = await tx.insert(reviews).values(values).returning();
    return row;
  }

  async updateReview(
    tx: Tx,
    reviewId: string,
    values: Partial<typeof reviews.$inferInsert>,
  ): Promise<ReviewRow> {
    const [row] = await tx
      .update(reviews)
      .set(values)
      .where(eq(reviews.id, reviewId))
      .returning();
    return row;
  }

  async shareReviews(
    tx: Tx,
    submissionId: string,
    reviewIds: readonly string[],
  ): Promise<number> {
    if (reviewIds.length === 0) {
      return 0;
    }
    const rows = await tx
      .update(reviews)
      .set({ sharedWithAuthor: true })
      .where(
        and(
          eq(reviews.submissionId, submissionId),
          inArray(reviews.id, [...reviewIds]),
        ),
      )
      .returning({ id: reviews.id });
    return rows.length;
  }

  /** Sent reviews of assignments that still count, oldest first. */
  async submittedReviews(
    executor: Executor,
    submissionId: string,
  ): Promise<ReviewRow[]> {
    const rows = await executor
      .select({ review: reviews })
      .from(reviews)
      .innerJoin(
        reviewAssignments,
        eq(reviewAssignments.id, reviews.assignmentId),
      )
      .where(
        and(
          eq(reviews.submissionId, submissionId),
          eq(reviews.status, 'submitted'),
          notInArray(reviewAssignments.status, ['declined', 'removed']),
        ),
      )
      .orderBy(asc(reviews.submittedAt), asc(reviews.id));
    return rows.map((r) => r.review);
  }

  /** Whether every assignment that counts on the paper has its review in. */
  async reviewProgress(
    executor: Executor,
    submissionId: string,
  ): Promise<{ active: number; submitted: ReviewRow[] }> {
    const [row] = await executor
      .select({ active: sql<number>`count(*)::int` })
      .from(reviewAssignments)
      .where(
        and(
          eq(reviewAssignments.submissionId, submissionId),
          inArray(reviewAssignments.status, [...ACTIVE_ASSIGNMENTS]),
        ),
      );
    return {
      active: row?.active ?? 0,
      submitted: await this.submittedReviews(executor, submissionId),
    };
  }

  // Reviewer's queue ----------------------------------------------------------------------------

  /** The reviewer's papers (assignments that still show the paper), with each paper's details. */
  async myAssignments(
    executor: Executor,
    reviewerId: string,
    conferenceId?: string,
  ) {
    return executor
      .select({
        assignmentId: reviewAssignments.id,
        submission: {
          id: submissions.id,
          paperNo: submissions.paperNo,
          title: submissions.title,
          abstract: submissions.abstract,
          keywords: submissions.keywords,
          details: submissions.details,
          status: submissions.status,
          outcome: submissions.outcome,
          conferenceId: submissions.conferenceId,
        },
        conference: {
          slug: conferences.slug,
          acronym: conferences.acronym,
          status: conferences.status,
        },
      })
      .from(reviewAssignments)
      .innerJoin(
        submissions,
        eq(submissions.id, reviewAssignments.submissionId),
      )
      .innerJoin(conferences, eq(conferences.id, submissions.conferenceId))
      .where(
        and(
          eq(reviewAssignments.reviewerId, reviewerId),
          inArray(reviewAssignments.status, [...ACTIVE_ASSIGNMENTS]),
          ne(conferences.status, 'deleted'),
          conferenceId ? eq(submissions.conferenceId, conferenceId) : undefined,
        ),
      )
      .orderBy(asc(conferences.acronym), asc(submissions.paperNo));
  }

  // Decision types ------------------------------------------------------------------------------

  async decisionTypes(
    executor: Executor,
    conferenceId: string,
  ): Promise<DecisionTypeRow[]> {
    return executor
      .select()
      .from(decisionTypes)
      .where(eq(decisionTypes.conferenceId, conferenceId))
      .orderBy(asc(decisionTypes.position), asc(decisionTypes.label));
  }

  async decisionTypeLabel(
    executor: Executor,
    decisionTypeId: string | null,
  ): Promise<string | null> {
    if (!decisionTypeId) {
      return null;
    }
    const [row] = await executor
      .select({ label: decisionTypes.label })
      .from(decisionTypes)
      .where(eq(decisionTypes.id, decisionTypeId));
    return row?.label ?? null;
  }

  /** How many papers use each of these types (as recorded, or as told to the authors). */
  async decisionTypeUse(
    executor: Executor,
    typeIds: readonly string[],
  ): Promise<Map<string, number>> {
    if (typeIds.length === 0) {
      return new Map();
    }
    const ids = [...typeIds];
    const used = await executor
      .select({
        decisionTypeId: submissions.decisionTypeId,
        notifiedDecisionTypeId: submissions.notifiedDecisionTypeId,
      })
      .from(submissions)
      .where(
        or(
          inArray(submissions.decisionTypeId, ids),
          inArray(submissions.notifiedDecisionTypeId, ids),
        ),
      );
    const counts = new Map<string, number>();
    for (const row of used) {
      for (const id of new Set([
        row.decisionTypeId,
        row.notifiedDecisionTypeId,
      ])) {
        if (id && ids.includes(id)) {
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
      }
    }
    return counts;
  }

  async replaceDecisionTypes(
    tx: Tx,
    conferenceId: string,
    keep: (typeof decisionTypes.$inferInsert & { id: string })[],
    fresh: (typeof decisionTypes.$inferInsert)[],
    remove: readonly string[],
  ): Promise<void> {
    if (remove.length > 0) {
      await tx
        .delete(decisionTypes)
        .where(
          and(
            eq(decisionTypes.conferenceId, conferenceId),
            inArray(decisionTypes.id, [...remove]),
          ),
        );
    }
    for (const row of keep) {
      await tx
        .update(decisionTypes)
        .set({
          label: row.label,
          color: row.color,
          outcome: row.outcome,
          description: row.description,
          position: row.position,
        })
        .where(
          and(
            eq(decisionTypes.id, row.id),
            eq(decisionTypes.conferenceId, conferenceId),
          ),
        );
    }
    if (fresh.length > 0) {
      await tx.insert(decisionTypes).values(fresh);
    }
  }

  // Conference dates for the emails -----------------------------------------------------------

  async conferenceDates(executor: Executor, conferenceId: string) {
    const [row] = await executor
      .select({
        reviewDeadline: conferences.reviewDeadline,
        notificationDate: conferences.notificationDate,
        cameraReadyDeadline: conferences.cameraReadyDeadline,
      })
      .from(conferences)
      .where(eq(conferences.id, conferenceId));
    return row;
  }

  /** Review progress of every paper of a conference: reviewers on it, reviews sent, their average score. */
  async paperStats(
    executor: Executor,
    conferenceId: string,
  ): Promise<
    Map<
      string,
      {
        reviewersAssigned: number;
        reviewsReceived: number;
        averageScore: number | null;
      }
    >
  > {
    const [assigned, pending, received] = await Promise.all([
      executor
        .select({
          submissionId: reviewAssignments.submissionId,
          n: sql<number>`count(*)::int`,
        })
        .from(reviewAssignments)
        .innerJoin(
          submissions,
          eq(submissions.id, reviewAssignments.submissionId),
        )
        .where(
          and(
            eq(submissions.conferenceId, conferenceId),
            inArray(reviewAssignments.status, [
              'assigned',
              'accepted',
              'submitted',
            ]),
          ),
        )
        .groupBy(reviewAssignments.submissionId),
      executor
        .select({
          submissionId: pendingReviewAssignments.submissionId,
          n: sql<number>`count(*)::int`,
        })
        .from(pendingReviewAssignments)
        .innerJoin(
          submissions,
          eq(submissions.id, pendingReviewAssignments.submissionId),
        )
        .where(eq(submissions.conferenceId, conferenceId))
        .groupBy(pendingReviewAssignments.submissionId),
      executor
        .select({
          submissionId: reviews.submissionId,
          n: sql<number>`count(*)::int`,
          average: sql<number | null>`avg(${reviews.score})::float8`,
        })
        .from(reviews)
        .innerJoin(submissions, eq(submissions.id, reviews.submissionId))
        .where(
          and(
            eq(submissions.conferenceId, conferenceId),
            eq(reviews.status, 'submitted'),
          ),
        )
        .groupBy(reviews.submissionId),
    ]);
    const stats = new Map<
      string,
      {
        reviewersAssigned: number;
        reviewsReceived: number;
        averageScore: number | null;
      }
    >();
    const entry = (id: string) => {
      let e = stats.get(id);
      if (!e) {
        e = { reviewersAssigned: 0, reviewsReceived: 0, averageScore: null };
        stats.set(id, e);
      }
      return e;
    };
    for (const r of assigned) entry(r.submissionId).reviewersAssigned += r.n;
    for (const r of pending) entry(r.submissionId).reviewersAssigned += r.n;
    for (const r of received) {
      const e = entry(r.submissionId);
      e.reviewsReceived = r.n;
      e.averageScore = r.average;
    }
    return stats;
  }
}
