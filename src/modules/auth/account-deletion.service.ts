import { HttpStatus, Injectable } from '@nestjs/common';
import { eq, inArray, ne, and, sql } from 'drizzle-orm';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Executor } from '../../core/database/database.types.js';
import {
  conferenceDeletionRequests,
  conferenceMembers,
  conferences,
  decisionEvents,
  pendingReviewAssignments,
  reviewAssignments,
  reviews,
  submissionFiles,
  submissions,
  users,
} from '../../core/database/schema/index.js';
import { AppException, ErrorCode } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import { FileStorage } from '../../core/storage/file-storage.js';
import { storagePaths } from '../../core/storage/storage-paths.js';

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * Deleting the signed-in person's own account. An account that still owns records other people depend
 * on is NOT deleted (the person is told what is in the way): it created a conference, chairs or manages
 * one, submitted a paper, wrote a review, or is named on records such as invitations and decisions.
 * Otherwise the user row goes, and the profile, sessions, sign-in tokens, notifications, connected
 * providers and review assignments go with it through the database's own "on delete cascade";
 * co-author rows only lose the link to the account. The person's uploaded photos are removed too.
 */
@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly storage: FileStorage,
  ) {}

  async delete(
    user: AuthUser,
    confirm: string,
    client: ClientInfo,
  ): Promise<void> {
    if (confirm.trim().toUpperCase() !== 'DELETE') {
      throw AppException.validation('Type DELETE to confirm.', [
        { field: 'confirm', errors: ['must be DELETE'] },
      ]);
    }

    await this.database.transaction(async (tx) => {
      const blockers = await this.blockers(tx, user.id);
      if (blockers.length > 0) {
        throw new AppException(
          HttpStatus.CONFLICT,
          ErrorCode.CONFLICT,
          "This account can't be deleted yet: it still has records that belong to conferences.",
          { blockers },
        );
      }
      const removed = await tx
        .delete(users)
        .where(eq(users.id, user.id))
        .returning({ id: users.id });
      if (removed.length === 0) {
        throw AppException.notFound('Your account');
      }
      // The person is gone, so the record carries no actor and no address, only that it happened.
      await this.audit.record(
        {
          action: 'account.deleted',
          actorId: null,
          entityType: 'user',
          entityId: user.id,
          client,
        },
        tx,
      );
    });

    // After the commit: a failure here must not undo the deletion (files are only left behind).
    await this.storage
      .deleteFolder(storagePaths.userFolder(user.id))
      .catch(() => undefined);
  }

  /** What stands in the way, as sentences ready to show. Empty when the account can be deleted. */
  private async blockers(tx: Executor, userId: string): Promise<string[]> {
    const count = async (
      query: PromiseLike<{ n: number }[]>,
    ): Promise<number> => (await query)[0]?.n ?? 0;
    const n = sql<number>`count(*)::int`;

    const created = await count(
      tx
        .select({ n })
        .from(conferences)
        .where(eq(conferences.createdBy, userId)),
    );
    const roles = await count(
      tx
        .select({ n })
        .from(conferenceMembers)
        .where(
          and(
            eq(conferenceMembers.userId, userId),
            inArray(conferenceMembers.role, [
              'chair',
              'track_chair',
              'cfp_manager',
            ]),
            ne(conferenceMembers.status, 'removed'),
          ),
        ),
    );
    const papers = await count(
      tx
        .select({ n })
        .from(submissions)
        .where(eq(submissions.submitterId, userId)),
    );
    const written = await count(
      tx.select({ n }).from(reviews).where(eq(reviews.reviewerId, userId)),
    );

    // Records that name the person as the one who did something (no cascade: they would block the delete).
    const named = (
      await Promise.all([
        count(
          tx
            .select({ n })
            .from(conferenceDeletionRequests)
            .where(eq(conferenceDeletionRequests.requestedBy, userId)),
        ),
        count(
          tx
            .select({ n })
            .from(conferenceDeletionRequests)
            .where(eq(conferenceDeletionRequests.decidedBy, userId)),
        ),
        count(
          tx
            .select({ n })
            .from(conferenceMembers)
            .where(eq(conferenceMembers.invitedBy, userId)),
        ),
        count(
          tx
            .select({ n })
            .from(decisionEvents)
            .where(eq(decisionEvents.decidedBy, userId)),
        ),
        count(
          tx
            .select({ n })
            .from(pendingReviewAssignments)
            .where(eq(pendingReviewAssignments.assignedBy, userId)),
        ),
        count(
          tx
            .select({ n })
            .from(reviewAssignments)
            .where(eq(reviewAssignments.assignedBy, userId)),
        ),
        count(
          tx
            .select({ n })
            .from(submissionFiles)
            .where(eq(submissionFiles.uploadedBy, userId)),
        ),
        count(
          tx
            .select({ n })
            .from(submissions)
            .where(eq(submissions.decidedBy, userId)),
        ),
      ])
    ).reduce((a, b) => a + b, 0);

    return [
      created > 0 &&
        plural(created, 'conference you created', 'conferences you created'),
      roles > 0 &&
        plural(
          roles,
          'conference where you are a chair, track chair or CFP manager',
          'conferences where you are a chair, track chair or CFP manager',
        ),
      papers > 0 &&
        plural(papers, 'paper you submitted', 'papers you submitted'),
      written > 0 && plural(written, 'review you wrote', 'reviews you wrote'),
      named > 0 &&
        plural(
          named,
          'other record you created or decided (invitations, decisions, uploaded files)',
          'other records you created or decided (invitations, decisions, uploaded files)',
        ),
    ].filter((b): b is string => typeof b === 'string');
  }
}
