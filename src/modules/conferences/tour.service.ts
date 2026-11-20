import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import { conferenceTourSeen } from '../../core/database/schema/index.js';
import { AccessService } from '../../core/rbac/access.service.js';
import type { TourStateResponse } from './dto/tour.dto.js';

/** Remembers, per person and conference, that the "Take a tour" guide has been shown. */
@Injectable()
export class TourService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
  ) {}

  async state(
    user: AuthUser,
    conferenceId: string,
  ): Promise<TourStateResponse> {
    return this.database.transaction(async (tx) => {
      await this.access.requireConference(user, conferenceId, tx);
      const [row] = await tx
        .select({ at: conferenceTourSeen.seenAt })
        .from(conferenceTourSeen)
        .where(
          and(
            eq(conferenceTourSeen.conferenceId, conferenceId),
            eq(conferenceTourSeen.userId, user.id),
          ),
        );
      return { seen: Boolean(row) };
    });
  }

  /** Idempotent: the first call writes the row, later calls change nothing. */
  async markSeen(user: AuthUser, conferenceId: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      await this.access.requireConference(user, conferenceId, tx);
      await tx
        .insert(conferenceTourSeen)
        .values({ conferenceId, userId: user.id })
        .onConflictDoNothing();
    });
  }
}
