import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Executor } from '../../core/database/database.types.js';
import {
  conferenceMembers,
  conferences,
  pendingReviewAssignments,
  profiles,
  reviewAssignments,
  submissions,
  users,
} from '../../core/database/schema/index.js';
import type { MemberRole } from '../../core/rbac/conf-roles.decorator.js';

export type MemberRow = typeof conferenceMembers.$inferSelect;

/** Paper states in which a waiting assignment still becomes a review request. */
const OPEN_OUTCOMES = [
  'upload_pending',
  'no_decision',
  'plagiarism_clear',
] as const;

const memberWithPerson = {
  member: conferenceMembers,
  email: users.email,
  firstName: profiles.firstName,
  lastName: profiles.lastName,
  affiliation: profiles.affiliation,
  photoPath: profiles.photoPath,
};

/** Database access for the conference team (chairs, CFP managers, reviewers). */
@Injectable()
export class MembersRepository {
  list(tx: Executor, conferenceId: string, role?: MemberRole) {
    return tx
      .select(memberWithPerson)
      .from(conferenceMembers)
      .leftJoin(users, eq(users.id, conferenceMembers.userId))
      .leftJoin(profiles, eq(profiles.id, conferenceMembers.userId))
      .where(
        and(
          eq(conferenceMembers.conferenceId, conferenceId),
          ne(conferenceMembers.status, 'removed'),
          role ? eq(conferenceMembers.role, role) : undefined,
        ),
      )
      .orderBy(asc(conferenceMembers.role), asc(conferenceMembers.invitedAt));
  }

  async findWithPerson(tx: Executor, memberId: string) {
    const [row] = await tx
      .select(memberWithPerson)
      .from(conferenceMembers)
      .leftJoin(users, eq(users.id, conferenceMembers.userId))
      .leftJoin(profiles, eq(profiles.id, conferenceMembers.userId))
      .where(eq(conferenceMembers.id, memberId));
    return row;
  }

  async findInConference(
    tx: Executor,
    conferenceId: string,
    memberId: string,
  ): Promise<MemberRow | undefined> {
    const [row] = await tx
      .select()
      .from(conferenceMembers)
      .where(
        and(
          eq(conferenceMembers.id, memberId),
          eq(conferenceMembers.conferenceId, conferenceId),
        ),
      )
      .for('update');
    return row;
  }

  async findForUpdate(
    tx: Executor,
    memberId: string,
  ): Promise<MemberRow | undefined> {
    const [row] = await tx
      .select()
      .from(conferenceMembers)
      .where(eq(conferenceMembers.id, memberId))
      .for('update');
    return row;
  }

  /** "ISBM 2027 — World Conference on …", for notifications. */
  async conferenceLabel(tx: Executor, conferenceId: string): Promise<string> {
    const [row] = await tx
      .select({ acronym: conferences.acronym, title: conferences.title })
      .from(conferences)
      .where(eq(conferences.id, conferenceId));
    return row ? `${row.acronym} — ${row.title}` : '';
  }

  /** The existing row for this person and role: by account, or by invited email. */
  async findExisting(
    tx: Executor,
    conferenceId: string,
    role: MemberRole,
    userId: string | null,
    email: string,
  ): Promise<MemberRow | undefined> {
    const [row] = await tx
      .select()
      .from(conferenceMembers)
      .where(
        and(
          eq(conferenceMembers.conferenceId, conferenceId),
          eq(conferenceMembers.role, role),
          userId
            ? eq(conferenceMembers.userId, userId)
            : and(
                isNull(conferenceMembers.userId),
                sql`lower(${conferenceMembers.invitedEmail}) = ${email}`,
              ),
        ),
      )
      .for('update');
    return row;
  }

  async insert(
    tx: Executor,
    values: typeof conferenceMembers.$inferInsert,
  ): Promise<MemberRow> {
    const [row] = await tx.insert(conferenceMembers).values(values).returning();
    return row;
  }

  async update(
    tx: Executor,
    memberId: string,
    values: Partial<typeof conferenceMembers.$inferInsert>,
  ): Promise<MemberRow> {
    const [row] = await tx
      .update(conferenceMembers)
      .set(values)
      .where(eq(conferenceMembers.id, memberId))
      .returning();
    return row;
  }

  async countActiveChairs(tx: Executor, conferenceId: string): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(conferenceMembers)
      .where(
        and(
          eq(conferenceMembers.conferenceId, conferenceId),
          eq(conferenceMembers.role, 'chair'),
          eq(conferenceMembers.status, 'active'),
        ),
      );
    return row.n;
  }

  /** The user's account id for an email, if one exists. */
  async userIdByEmail(tx: Executor, email: string): Promise<string | null> {
    const [row] = await tx
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`);
    return row?.id ?? null;
  }

  async personName(tx: Executor, userId: string): Promise<string> {
    const [row] = await tx
      .select({
        firstName: profiles.firstName,
        lastName: profiles.lastName,
        email: users.email,
      })
      .from(users)
      .leftJoin(profiles, eq(profiles.id, users.id))
      .where(eq(users.id, userId));
    return (
      [row?.firstName, row?.lastName].filter(Boolean).join(' ').trim() ||
      row?.email ||
      'Someone'
    );
  }

  /** The user's invitations and roles, with their conferences (deleted ones left out). */
  listForUser(tx: Executor, userId: string) {
    return tx
      .select({ member: conferenceMembers, conference: conferences })
      .from(conferenceMembers)
      .innerJoin(
        conferences,
        eq(conferences.id, conferenceMembers.conferenceId),
      )
      .where(
        and(
          eq(conferenceMembers.userId, userId),
          ne(conferenceMembers.status, 'removed'),
          ne(conferences.status, 'deleted'),
        ),
      )
      .orderBy(sql`${conferenceMembers.invitedAt} desc`);
  }

  // Effects on review assignments ------------------------------------------------------------

  /** Papers queued for this invitation become review requests (open papers only). */
  async activatePendingAssignments(
    tx: Executor,
    member: MemberRow,
    reviewerId: string,
  ): Promise<void> {
    const waiting = await tx
      .select({
        submissionId: pendingReviewAssignments.submissionId,
        dueAt: pendingReviewAssignments.dueAt,
        assignedBy: pendingReviewAssignments.assignedBy,
      })
      .from(pendingReviewAssignments)
      .innerJoin(
        submissions,
        eq(submissions.id, pendingReviewAssignments.submissionId),
      )
      .where(
        and(
          eq(pendingReviewAssignments.memberId, member.id),
          inArray(submissions.outcome, [...OPEN_OUTCOMES]),
        ),
      );
    if (waiting.length > 0) {
      await tx
        .insert(reviewAssignments)
        .values(waiting.map((w) => ({ ...w, reviewerId })))
        .onConflictDoNothing();
    }
  }

  async deletePendingAssignments(
    tx: Executor,
    memberId: string,
  ): Promise<void> {
    await tx
      .delete(pendingReviewAssignments)
      .where(eq(pendingReviewAssignments.memberId, memberId));
  }

  /** Hands back the papers given to the reviewer in this conference that they haven't accepted. */
  async declineOpenAssignments(
    tx: Executor,
    conferenceId: string,
    reviewerId: string,
    reason: string,
  ): Promise<void> {
    await tx
      .update(reviewAssignments)
      .set({
        status: 'declined',
        respondedAt: new Date(),
        declineReason: reason,
      })
      .where(
        and(
          eq(reviewAssignments.reviewerId, reviewerId),
          eq(reviewAssignments.status, 'assigned'),
          inArray(
            reviewAssignments.submissionId,
            tx
              .select({ id: submissions.id })
              .from(submissions)
              .where(eq(submissions.conferenceId, conferenceId)),
          ),
        ),
      );
  }

  /**
   * A removed reviewer's open assignments in the conference are withdrawn. Submitted reviews and
   * their assignments are kept: they are part of the paper's record.
   */
  async withdrawAssignments(
    tx: Executor,
    conferenceId: string,
    reviewerId: string,
  ): Promise<void> {
    await tx
      .update(reviewAssignments)
      .set({ status: 'removed' })
      .where(
        and(
          eq(reviewAssignments.reviewerId, reviewerId),
          inArray(reviewAssignments.status, ['assigned', 'accepted']),
          inArray(
            reviewAssignments.submissionId,
            tx
              .select({ id: submissions.id })
              .from(submissions)
              .where(eq(submissions.conferenceId, conferenceId)),
          ),
        ),
      );
  }
}
