import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { DatabaseService } from '../database/database.service.js';
import {
  conferences,
  reviewAssignments,
  reviews,
  submissions,
  users,
} from '../database/schema/index.js';
import { AppException, ErrorCode } from '../errors/app.exception.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A conference a Super Admin suspended is read-only for everyone else: no change goes through for
 * anything inside it (its settings, team, CFP, papers, reviews). The conference is found from the
 * route's :conferenceId (id or slug), :submissionId, :assignmentId or :reviewId. Reading still
 * works, and the admin console (/admin/…) and super admins in a verified session are not limited.
 */
@Injectable()
export class SuspensionGuard implements CanActivate {
  constructor(private readonly database: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    if (READS.has(request.method) || request.path.includes('/admin/')) {
      return true;
    }
    const conferenceId = await this.conferenceOf(request.params ?? {});
    if (!conferenceId) {
      return true;
    }
    const [row] = await this.database.db
      .select({
        suspendedAt: conferences.suspendedAt,
        acronym: conferences.acronym,
      })
      .from(conferences)
      .where(eq(conferences.id, conferenceId));
    if (!row?.suspendedAt) {
      return true;
    }
    if (request.user?.mfa) {
      const [me] = await this.database.db
        .select({ isSuperAdmin: users.isSuperAdmin })
        .from(users)
        .where(eq(users.id, request.user.id));
      if (me?.isSuperAdmin) {
        return true;
      }
    }
    throw new AppException(
      HttpStatus.FORBIDDEN,
      ErrorCode.CONFERENCE_SUSPENDED,
      `${row.acronym} is suspended by Smartconferu, so nothing can be changed in it for now. Contact support@smartconferu.com.`,
    );
  }

  private async conferenceOf(
    params: Record<string, string | string[] | undefined>,
  ): Promise<string | null> {
    const one = (v: string | string[] | undefined) =>
      typeof v === 'string' ? v : undefined;
    const db = this.database.db;
    const conferenceId = one(params.conferenceId);
    const submissionId = one(params.submissionId);
    const assignmentId = one(params.assignmentId);
    const reviewId = one(params.reviewId);
    if (conferenceId) {
      if (UUID.test(conferenceId)) return conferenceId;
      const [row] = await db
        .select({ id: conferences.id })
        .from(conferences)
        .where(eq(conferences.slug, conferenceId.toLowerCase()));
      return row?.id ?? null;
    }
    if (submissionId && UUID.test(submissionId)) {
      const [row] = await db
        .select({ id: submissions.conferenceId })
        .from(submissions)
        .where(eq(submissions.id, submissionId));
      return row?.id ?? null;
    }
    const byAssignment =
      assignmentId && UUID.test(assignmentId) ? assignmentId : null;
    const byReview = reviewId && UUID.test(reviewId) ? reviewId : null;
    if (byAssignment || byReview) {
      const [row] = await db
        .select({ id: submissions.conferenceId })
        .from(reviewAssignments)
        .innerJoin(
          submissions,
          eq(submissions.id, reviewAssignments.submissionId),
        )
        .leftJoin(reviews, eq(reviews.assignmentId, reviewAssignments.id))
        .where(
          byAssignment
            ? eq(reviewAssignments.id, byAssignment)
            : eq(reviews.id, byReview!),
        )
        .limit(1);
      return row?.id ?? null;
    }
    return null;
  }
}
