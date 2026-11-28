import * as rules from '../../core/rbac/access-rules.js';
import type { SubmissionAccess } from '../../core/rbac/access-rules.js';
import type {
  AssignmentResponse,
  AuthorReviewResponse,
  DecisionTypeResponse,
  PendingAssignmentResponse,
  ReviewResponse,
  ReviewSummary,
} from './dto/review.dto.js';
import type {
  AssignmentBundle,
  DecisionTypeRow,
  PendingBundle,
  ReviewRow,
} from './reviews.repository.js';

const iso = (value: Date | null) => value?.toISOString() ?? null;

export function toReview(r: ReviewRow): ReviewResponse {
  return {
    id: r.id,
    status: r.status,
    score: r.score,
    confidence: r.confidence,
    recommendation: r.recommendation,
    commentsToAuthor: r.commentsToAuthor,
    commentsToChair: r.commentsToChair,
    answers: r.answers as Record<string, unknown>,
    sharedWithAuthor: r.sharedWithAuthor,
    submittedAt: iso(r.submittedAt),
    editedByChairAt: iso(r.editedByChairAt),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * An assignment as a chair or its own reviewer sees it. `access` is the reviewer's own standing on
 * the paper (for what they may do); null when a chair looks at someone else's assignment.
 */
export function toAssignment(
  b: AssignmentBundle,
  access: SubmissionAccess | null,
): AssignmentResponse {
  const a = b.assignment;
  const own = access !== null && access.assignmentStatus !== null;
  return {
    id: a.id,
    submissionId: a.submissionId,
    reviewer: b.reviewer,
    status: a.status,
    // A chair's own review is an assignment nobody made ("Review as chair").
    byChair: a.assignedBy === null,
    dueAt: iso(a.dueAt),
    assignedAt: a.assignedAt.toISOString(),
    respondedAt: iso(a.respondedAt),
    declineReason: a.declineReason,
    review: b.review ? toReview(b.review) : null,
    extension: b.extension
      ? {
          id: b.extension.id,
          date: b.extension.requestedDate,
          reason: b.extension.reason,
          status: b.extension.status,
          note: b.extension.note,
          createdAt: b.extension.createdAt.toISOString(),
          decidedAt: iso(b.extension.decidedAt),
        }
      : null,
    can: {
      respond: own && a.status === 'assigned',
      review:
        own &&
        (b.review
          ? rules.canEditOwnReview(access)
          : rules.canWriteReview(access) && rules.canEditOwnReview(access)),
    },
  };
}

export function toPending(p: PendingBundle): PendingAssignmentResponse {
  return {
    id: p.pending.id,
    memberId: p.pending.memberId,
    name: p.name,
    email: p.email,
    dueAt: iso(p.pending.dueAt),
    createdAt: p.pending.createdAt.toISOString(),
  };
}

/** The reviews shown to authors: anonymised and numbered in the order they were sent. */
export function toAuthorReviews(sent: ReviewRow[]): AuthorReviewResponse[] {
  return sent
    .map((r, i) => ({ r, reviewerNo: i + 1 }))
    .filter(({ r }) => r.sharedWithAuthor)
    .map(({ r, reviewerNo }) => ({
      reviewerNo,
      score: r.score,
      recommendation: r.recommendation,
      commentsToAuthor: r.commentsToAuthor,
      submittedAt: iso(r.submittedAt),
    }));
}

export function averageScore(sent: readonly ReviewRow[]): number | null {
  const scores = sent
    .map((r) => r.score)
    .filter((s): s is number => typeof s === 'number');
  return scores.length > 0
    ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
    : null;
}

export function summarize(bundles: readonly AssignmentBundle[]): ReviewSummary {
  const active = bundles.filter(
    (b) =>
      b.assignment.status !== 'declined' && b.assignment.status !== 'removed',
  );
  const sent = active.flatMap((b) =>
    b.review?.status === 'submitted' ? [b.review] : [],
  );
  return {
    assigned: active.length,
    submitted: sent.length,
    averageScore: averageScore(sent),
    complete: active.length > 0 && sent.length === active.length,
  };
}

export function toDecisionType(t: DecisionTypeRow): DecisionTypeResponse {
  return {
    id: t.id,
    label: t.label,
    color: t.color,
    outcome: t.outcome,
    description: t.description,
    authorLabel: t.authorLabel,
    position: t.position,
  };
}
