import { sql, type SQL } from 'drizzle-orm';
import { submissionAuthors, submissions } from '../database/schema/index.js';

/**
 * Who a paper belongs to as an author. A paper is mine when I am listed among its authors, or I
 * submitted it myself. A chair who submitted it on an author's behalf is not one of its authors:
 * the paper isn't in their My Submissions, their author dashboard or their author activity log.
 */

/** Was the paper submitted by a chair on an author's behalf? (`details.onBehalf`) */
export function isOnBehalf(details: unknown): boolean {
  return (
    typeof details === 'object' &&
    details !== null &&
    (details as Record<string, unknown>).onBehalf === true
  );
}

/** Did this user submit the paper as one of its authors (not for someone else)? */
export function submittedAsAuthor(
  submission: { submitterId: string; details: unknown },
  userId: string,
): boolean {
  return submission.submitterId === userId && !isOnBehalf(submission.details);
}

/** SQL: the `submissions` row is one of this user's papers as an author. */
export function authoredBy(userId: string): SQL<boolean> {
  return sql<boolean>`((${submissions.submitterId} = ${userId}
      and coalesce((${submissions.details}->>'onBehalf')::boolean, false) = false)
    or ${submissions.id} in (
      select ${submissionAuthors.submissionId} from ${submissionAuthors}
      where ${submissionAuthors.userId} = ${userId}))`;
}
