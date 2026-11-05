import { Injectable } from '@nestjs/common';
import { and, isNull, sql } from 'drizzle-orm';
import { normalizeEmail } from '../../core/auth/secrets.js';
import type { Executor } from '../../core/database/database.types.js';
import {
  conferenceMembers,
  submissionAuthors,
} from '../../core/database/schema/index.js';

/**
 * Connects an account to everything waiting for its email address: committee invitations sent
 * before the person signed up, and papers listing them as a co-author. Runs once the address is
 * proven (verification link, sign-in code, password reset, or a provider's verified email).
 */
@Injectable()
export class AccountLinkingService {
  async linkByEmail(
    executor: Executor,
    userId: string,
    email: string,
  ): Promise<void> {
    const address = normalizeEmail(email);

    await executor
      .update(conferenceMembers)
      .set({ userId })
      .where(
        and(
          isNull(conferenceMembers.userId),
          sql`lower(${conferenceMembers.invitedEmail}) = ${address}`,
          // Already a member in this role (e.g. invited twice): leave the duplicate invitation.
          sql`not exists (
            select 1 from ${conferenceMembers} as existing
            where existing.conference_id = ${conferenceMembers.conferenceId}
              and existing.user_id = ${userId}
              and existing.role = ${conferenceMembers.role})`,
        ),
      );

    await executor
      .update(submissionAuthors)
      .set({ userId })
      .where(
        and(
          isNull(submissionAuthors.userId),
          sql`lower(${submissionAuthors.email}) = ${address}`,
        ),
      );
  }
}
