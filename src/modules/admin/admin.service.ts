import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service.js';
import {
  auditLog,
  conferenceDeletionRequests,
  conferenceMembers,
  conferences,
  decisionTypes,
  emailLog,
  profiles,
  reviewAssignments,
  reviews,
  sessions,
  submissionAuthors,
  submissions,
  userMfa,
  users,
} from '../../core/database/schema/index.js';
import { AppException, ErrorCode } from '../../core/errors/app.exception.js';
import { decodeCursor, keyset, page } from '../../core/http/pagination.js';
import { paperId, STAGE_OUTCOMES } from '../submissions/submission.mapper.js';
import type {
  ActivityPage,
  AdminPaperResponse,
  AdminStatsResponse,
  AdminUserDetailResponse,
  AdminUserPage,
  AdminUserResponse,
  ActivityQuery,
  UsersQuery,
} from './dto/admin.dto.js';

/** Papers a conference wants reviewed by this many reviewers unless its settings say otherwise. */
const DEFAULT_REVIEWERS_PER_PAPER = 2;

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const name = (
  first: string | null,
  last: string | null,
  email: string | null,
) => [first, last].filter(Boolean).join(' ').trim() || email || '—';

type Stage =
  | 'upload'
  | 'screening'
  | 'needs_reviewers'
  | 'awaiting_response'
  | 'in_review'
  | 'overdue'
  | 'ready'
  | 'decided';

/**
 * Where a paper stands in review, the same stages as the chair's Peer Review list (the app's
 * src/data/platform.js paperStage).
 */
export function paperStage(
  outcome: string,
  active: readonly { status: string; dueAt: Date | null; submitted: boolean }[],
  target: number,
  today: string,
): Stage {
  if (!STAGE_OUTCOMES.includes(outcome)) {
    return 'decided';
  }
  if (outcome === 'upload_pending') {
    return 'upload';
  }
  if (outcome === 'no_decision') {
    return 'screening';
  }
  if (active.length === 0) {
    return 'needs_reviewers';
  }
  const done = active.filter((a) => a.submitted).length;
  if (done === active.length && done >= Math.min(target, active.length)) {
    return 'ready';
  }
  if (active.some((a) => !a.submitted && a.dueAt && day(a.dueAt)! < today)) {
    return 'overdue';
  }
  if (active.some((a) => a.status === 'assigned')) {
    return 'awaiting_response';
  }
  return 'in_review';
}

/**
 * The super-admin console: platform numbers, every user, recent activity, and each conference's
 * review health. Replaces the console's direct reads of every table (src/data/platform.js).
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async stats(): Promise<AdminStatsResponse> {
    const db = this.database.db;
    const count = sql<number>`count(*)::int`;
    const byStatus = await db
      .select({ status: conferences.status, n: count })
      .from(conferences)
      .groupBy(conferences.status);
    const papers = await db
      .select({ status: submissions.status, n: count })
      .from(submissions)
      .innerJoin(conferences, eq(conferences.id, submissions.conferenceId))
      .where(sql`${conferences.status} <> 'deleted'`)
      .groupBy(submissions.status);
    const [people] = await db
      .select({
        total: count,
        disabled: sql<number>`count(*) filter (where ${users.status} = 'disabled')::int`,
        superAdmins: sql<number>`count(*) filter (where ${users.isSuperAdmin})::int`,
        newThisWeek: sql<number>`count(*) filter (where ${users.createdAt} > now() - interval '7 days')::int`,
      })
      .from(users);
    const [reviewCount] = await db
      .select({ n: count })
      .from(reviews)
      .where(eq(reviews.status, 'submitted'));
    const [deletions] = await db
      .select({ n: count })
      .from(conferenceDeletionRequests)
      .where(eq(conferenceDeletionRequests.status, 'pending'));
    const emails = await db
      .select({ status: emailLog.status, n: count })
      .from(emailLog)
      .where(sql`${emailLog.createdAt} > now() - interval '7 days'`)
      .groupBy(emailLog.status);
    const of = (rows: { status: string; n: number }[], status: string) =>
      rows.find((r) => r.status === status)?.n ?? 0;
    return {
      conferences: {
        pendingApproval: of(byStatus, 'pending_approval'),
        active: of(byStatus, 'active'),
        archived: of(byStatus, 'archived'),
        rejected: of(byStatus, 'rejected'),
        deleted: of(byStatus, 'deleted'),
        pendingDeletion: deletions?.n ?? 0,
      },
      papers: {
        submitted: of(papers, 'submitted'),
        withdrawn: of(papers, 'withdrawn'),
        drafts: of(papers, 'draft'),
      },
      users: {
        total: people?.total ?? 0,
        disabled: people?.disabled ?? 0,
        superAdmins: people?.superAdmins ?? 0,
        newThisWeek: people?.newThisWeek ?? 0,
      },
      reviewsSubmitted: reviewCount?.n ?? 0,
      emailsLastWeek: {
        sent: of(emails, 'sent'),
        queued: of(emails, 'queued') + of(emails, 'sending'),
        failed: of(emails, 'failed'),
      },
    };
  }

  /** Everyone with an account, newest first, with the roles their memberships and papers give them. */
  async users(query: UsersQuery): Promise<AdminUserPage> {
    const db = this.database.db;
    const limit = query.limit ?? 50;
    const order = keyset(
      users.createdAt,
      users.id,
      decodeCursor(query.cursor),
      'newest-first',
    );
    const search = query.search?.trim();
    const like = search ? `%${search.replace(/[%_\\]/g, '\\$&')}%` : undefined;
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        status: users.status,
        isSuperAdmin: users.isSuperAdmin,
        createdAt: users.createdAt,
        lastSignInAt: users.lastSignInAt,
        emailVerifiedAt: users.emailVerifiedAt,
        firstName: profiles.firstName,
        lastName: profiles.lastName,
        affiliation: profiles.affiliation,
        country: profiles.country,
        mfa: sql<boolean>`${userMfa.enabledAt} is not null`,
      })
      .from(users)
      .leftJoin(profiles, eq(profiles.id, users.id))
      .leftJoin(userMfa, eq(userMfa.userId, users.id))
      .where(
        and(
          like
            ? or(
                ilike(users.email, like),
                ilike(
                  sql`${profiles.firstName} || ' ' || ${profiles.lastName}`,
                  like,
                ),
                ilike(profiles.affiliation, like),
              )
            : undefined,
          order.where,
        ),
      )
      .orderBy(...order.orderBy)
      .limit(limit + 1);
    const result = page(rows, limit, (u) => ({ at: u.createdAt, id: u.id }));
    const ids = result.data.map((u) => u.id);
    const roles =
      ids.length > 0 ? await this.rolesOf(ids) : new Map<string, string[]>();
    return {
      data: result.data.map((u) => ({
        id: u.id,
        name: name(u.firstName, u.lastName, u.email),
        email: u.email,
        affiliation: u.affiliation,
        country: u.country,
        roles: [
          ...(u.isSuperAdmin ? ['super_admin'] : []),
          ...(roles.get(u.id) ?? []),
        ],
        status: u.status,
        emailVerified: u.emailVerifiedAt !== null,
        twoStepOn: u.mfa,
        createdAt: u.createdAt.toISOString(),
        lastSignInAt: u.lastSignInAt?.toISOString() ?? null,
      })),
      nextCursor: result.nextCursor,
    };
  }

  /** One account: what the users list shows, plus their conferences and recent activity. */
  async user(id: string): Promise<AdminUserDetailResponse> {
    const summary = await this.userSummary(id);
    const db = this.database.db;
    const memberships = await db
      .select({
        id: conferences.id,
        slug: conferences.slug,
        acronym: conferences.acronym,
        title: conferences.title,
        status: conferences.status,
        role: conferenceMembers.role,
      })
      .from(conferenceMembers)
      .innerJoin(
        conferences,
        eq(conferences.id, conferenceMembers.conferenceId),
      )
      .where(
        and(
          eq(conferenceMembers.userId, id),
          eq(conferenceMembers.status, 'active'),
        ),
      )
      .orderBy(asc(conferences.acronym));
    const authored = await db
      .select({
        id: conferences.id,
        slug: conferences.slug,
        acronym: conferences.acronym,
        title: conferences.title,
        status: conferences.status,
        papers: sql<number>`count(distinct ${submissions.id})::int`,
      })
      .from(submissions)
      .innerJoin(conferences, eq(conferences.id, submissions.conferenceId))
      .leftJoin(
        submissionAuthors,
        eq(submissionAuthors.submissionId, submissions.id),
      )
      .where(
        or(eq(submissions.submitterId, id), eq(submissionAuthors.userId, id)),
      )
      .groupBy(conferences.id)
      .orderBy(asc(conferences.acronym));
    const byConference = new Map<
      string,
      AdminUserDetailResponse['conferences'][number]
    >();
    const entry = (c: {
      id: string;
      slug: string;
      acronym: string;
      title: string;
      status: string;
    }) => {
      let e = byConference.get(c.id);
      if (!e) {
        e = {
          id: c.id,
          slug: c.slug,
          acronym: c.acronym,
          title: c.title,
          status: c.status,
          roles: [],
          papers: 0,
        };
        byConference.set(c.id, e);
      }
      return e;
    };
    for (const m of memberships) {
      const role = m.role === 'track_chair' ? 'chair' : m.role;
      const e = entry(m);
      if (!e.roles.includes(role)) e.roles.push(role);
    }
    for (const a of authored) {
      const e = entry(a);
      e.roles.push('author');
      e.papers = a.papers;
    }
    const activity = await this.activity({ actorId: id, limit: 20 });
    return Object.assign({}, summary, {
      conferences: [...byConference.values()],
      recentActivity: activity.data,
    });
  }

  /**
   * Suspends (status disabled: every session ends, signing in is refused) or reactivates an
   * account. A super admin can't suspend themself or another super admin.
   */
  async setUserStatus(
    admin: AuthUser,
    id: string,
    status: 'active' | 'disabled',
    reason: string | undefined,
    client: ClientInfo,
  ): Promise<AdminUserResponse> {
    await this.database.transaction(async (tx) => {
      const [target] = await tx
        .select({
          id: users.id,
          status: users.status,
          isSuperAdmin: users.isSuperAdmin,
        })
        .from(users)
        .where(eq(users.id, id))
        .for('update');
      if (!target) {
        throw AppException.notFound('User');
      }
      if (
        status === 'disabled' &&
        (target.id === admin.id || target.isSuperAdmin)
      ) {
        throw new AppException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ErrorCode.BUSINESS_RULE,
          target.id === admin.id
            ? "You can't suspend your own account."
            : "A super admin's account can't be suspended here.",
        );
      }
      if (target.status === status) {
        return;
      }
      await tx.update(users).set({ status }).where(eq(users.id, id));
      if (status === 'disabled') {
        await tx
          .update(sessions)
          .set({ revokedAt: new Date(), revokedReason: 'suspended' })
          .where(and(eq(sessions.userId, id), isNull(sessions.revokedAt)));
      }
      await this.audit.record(
        {
          action:
            status === 'disabled'
              ? 'admin.user_suspended'
              : 'admin.user_reactivated',
          actorId: admin.id,
          entityType: 'user',
          entityId: id,
          client,
          data: reason ? { reason } : {},
        },
        tx,
      );
    });
    return this.userSummary(id);
  }

  private async userSummary(id: string): Promise<AdminUserResponse> {
    const [u] = await this.database.db
      .select({
        id: users.id,
        email: users.email,
        status: users.status,
        isSuperAdmin: users.isSuperAdmin,
        createdAt: users.createdAt,
        lastSignInAt: users.lastSignInAt,
        emailVerifiedAt: users.emailVerifiedAt,
        firstName: profiles.firstName,
        lastName: profiles.lastName,
        affiliation: profiles.affiliation,
        country: profiles.country,
        mfa: sql<boolean>`${userMfa.enabledAt} is not null`,
      })
      .from(users)
      .leftJoin(profiles, eq(profiles.id, users.id))
      .leftJoin(userMfa, eq(userMfa.userId, users.id))
      .where(eq(users.id, id));
    if (!u) {
      throw AppException.notFound('User');
    }
    const roles = (await this.rolesOf([id])).get(id) ?? [];
    return {
      id: u.id,
      name: name(u.firstName, u.lastName, u.email),
      email: u.email,
      affiliation: u.affiliation,
      country: u.country,
      roles: [...(u.isSuperAdmin ? ['super_admin'] : []), ...roles],
      status: u.status,
      emailVerified: u.emailVerifiedAt !== null,
      twoStepOn: u.mfa,
      createdAt: u.createdAt.toISOString(),
      lastSignInAt: u.lastSignInAt?.toISOString() ?? null,
    };
  }

  /** Chair / reviewer / cfp manager from active memberships, author from papers. */
  private async rolesOf(userIds: string[]): Promise<Map<string, string[]>> {
    const db = this.database.db;
    const members = await db
      .selectDistinct({
        userId: conferenceMembers.userId,
        role: conferenceMembers.role,
      })
      .from(conferenceMembers)
      .where(
        and(
          inArray(conferenceMembers.userId, userIds),
          eq(conferenceMembers.status, 'active'),
        ),
      );
    const authors = await db
      .selectDistinct({ userId: submissions.submitterId })
      .from(submissions)
      .where(inArray(submissions.submitterId, userIds))
      .union(
        db
          .selectDistinct({ userId: sql<string>`${submissionAuthors.userId}` })
          .from(submissionAuthors)
          .where(inArray(submissionAuthors.userId, userIds)),
      );
    const out = new Map<string, Set<string>>();
    const add = (id: string | null, role: string) => {
      if (id) {
        out.set(id, (out.get(id) ?? new Set()).add(role));
      }
    };
    for (const m of members) {
      add(m.userId, m.role === 'track_chair' ? 'chair' : m.role);
    }
    for (const a of authors) {
      add(a.userId, 'author');
    }
    const order = ['chair', 'cfp_manager', 'reviewer', 'author'];
    return new Map(
      [...out.entries()].map(([id, set]) => [
        id,
        order.filter((r) => set.has(r)),
      ]),
    );
  }

  /** What happened on the platform, newest first (from the audit log). */
  async activity(query: ActivityQuery): Promise<ActivityPage> {
    const limit = query.limit ?? 50;
    const rows = await this.database.db
      .select({
        id: auditLog.id,
        occurredAt: auditLog.occurredAt,
        action: auditLog.action,
        entityType: auditLog.entityType,
        entityId: auditLog.entityId,
        data: auditLog.data,
        actorId: auditLog.actorId,
        actorEmail: users.email,
        firstName: profiles.firstName,
        lastName: profiles.lastName,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorId))
      .leftJoin(profiles, eq(profiles.id, auditLog.actorId))
      .where(
        and(
          query.before ? lt(auditLog.id, query.before) : undefined,
          query.action
            ? sql`${auditLog.action} like ${`${query.action}%`}`
            : undefined,
          query.actorId ? eq(auditLog.actorId, query.actorId) : undefined,
        ),
      )
      .orderBy(desc(auditLog.id))
      .limit(limit + 1);
    const data = rows.slice(0, limit);
    return {
      data: data.map((r) => ({
        id: r.id,
        occurredAt: r.occurredAt.toISOString(),
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        actor: r.actorId
          ? {
              id: r.actorId,
              name: name(r.firstName, r.lastName, r.actorEmail),
              email: r.actorEmail,
            }
          : null,
        data: r.data as Record<string, unknown>,
      })),
      nextBefore: rows.length > limit ? (data.at(-1)?.id ?? null) : null,
    };
  }

  /** A conference's papers with where each stands in review and who reviews it. */
  async conferencePapers(conferenceId: string): Promise<AdminPaperResponse[]> {
    const db = this.database.db;
    const [conference] = await db
      .select({
        acronym: conferences.acronym,
        settings: conferences.settings,
      })
      .from(conferences)
      .where(eq(conferences.id, conferenceId));
    if (!conference) {
      throw AppException.notFound('The conference');
    }
    const settings = conference.settings as Record<string, unknown>;
    const target =
      typeof settings.reviewersPerPaper === 'number' &&
      settings.reviewersPerPaper > 0
        ? settings.reviewersPerPaper
        : DEFAULT_REVIEWERS_PER_PAPER;

    const papers = await db
      .select({
        id: submissions.id,
        paperNo: submissions.paperNo,
        title: submissions.title,
        status: submissions.status,
        outcome: submissions.outcome,
        notifiedOutcome: submissions.notifiedOutcome,
        details: submissions.details,
        submittedAt: submissions.submittedAt,
        updatedAt: submissions.updatedAt,
        decision: decisionTypes.label,
      })
      .from(submissions)
      .leftJoin(decisionTypes, eq(decisionTypes.id, submissions.decisionTypeId))
      .where(eq(submissions.conferenceId, conferenceId))
      .orderBy(asc(submissions.paperNo));
    if (papers.length === 0) {
      return [];
    }
    const ids = papers.map((p) => p.id);
    const assignments = await db
      .select({
        submissionId: reviewAssignments.submissionId,
        status: reviewAssignments.status,
        dueAt: reviewAssignments.dueAt,
        assignedAt: reviewAssignments.assignedAt,
        assignedBy: reviewAssignments.assignedBy,
        declineReason: reviewAssignments.declineReason,
        reviewerId: reviewAssignments.reviewerId,
        email: users.email,
        firstName: profiles.firstName,
        lastName: profiles.lastName,
        reviewStatus: reviews.status,
        score: reviews.score,
        recommendation: reviews.recommendation,
        reviewSubmittedAt: reviews.submittedAt,
      })
      .from(reviewAssignments)
      .innerJoin(users, eq(users.id, reviewAssignments.reviewerId))
      .leftJoin(profiles, eq(profiles.id, reviewAssignments.reviewerId))
      .leftJoin(reviews, eq(reviews.assignmentId, reviewAssignments.id))
      .where(inArray(reviewAssignments.submissionId, ids))
      .orderBy(asc(reviewAssignments.assignedAt));
    const authors = await db
      .select({
        submissionId: submissionAuthors.submissionId,
        name: submissionAuthors.name,
        email: submissionAuthors.email,
        affiliation: submissionAuthors.affiliation,
        corresponding: submissionAuthors.isCorresponding,
      })
      .from(submissionAuthors)
      .where(inArray(submissionAuthors.submissionId, ids))
      .orderBy(asc(submissionAuthors.position));

    const today = new Date().toISOString().slice(0, 10);
    return papers.map((p) => {
      const mine = assignments.filter((a) => a.submissionId === p.id);
      const active = mine.filter(
        (a) => a.status !== 'declined' && a.status !== 'removed',
      );
      const scores = active
        .filter(
          (a) => a.reviewStatus === 'submitted' && typeof a.score === 'number',
        )
        .map((a) => a.score!);
      const details = p.details as Record<string, unknown>;
      return {
        id: p.id,
        paperId: paperId(conference.acronym, p.paperNo),
        title: p.title,
        status: p.status,
        outcome: p.outcome,
        notifiedOutcome: p.notifiedOutcome,
        decision: STAGE_OUTCOMES.includes(p.outcome)
          ? null
          : (p.decision ?? p.outcome),
        track: typeof details.track === 'string' ? details.track : null,
        stage:
          p.status === 'submitted'
            ? paperStage(
                p.outcome,
                active.map((a) => ({
                  status: a.status,
                  dueAt: a.dueAt,
                  submitted: a.reviewStatus === 'submitted',
                })),
                target,
                today,
              )
            : null,
        reviewersWanted: target,
        reviewsIn: scores.length,
        averageScore:
          scores.length > 0
            ? Math.round(
                (scores.reduce((a, b) => a + b, 0) / scores.length) * 10,
              ) / 10
            : null,
        split:
          scores.length > 1 && Math.max(...scores) - Math.min(...scores) >= 2,
        authors: authors
          .filter((a) => a.submissionId === p.id)
          .map((a) => ({
            name: a.name,
            email: a.email,
            affiliation: a.affiliation,
            corresponding: a.corresponding,
          })),
        reviewers: mine.map((a) => ({
          userId: a.reviewerId,
          name: name(a.firstName, a.lastName, a.email),
          status: a.status,
          byChair: a.assignedBy === null,
          dueAt: a.dueAt?.toISOString() ?? null,
          assignedAt: a.assignedAt.toISOString(),
          declineReason: a.declineReason,
          reviewStatus: a.reviewStatus,
          score: a.reviewStatus === 'submitted' ? a.score : null,
          recommendation:
            a.reviewStatus === 'submitted' ? a.recommendation : null,
          submittedAt: a.reviewSubmittedAt?.toISOString() ?? null,
        })),
        submittedAt: p.submittedAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      };
    });
  }
}
