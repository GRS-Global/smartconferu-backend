import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { Executor } from '../database/database.types.js';
import {
  conferenceMembers,
  notifications,
  users,
} from '../database/schema/index.js';

export interface NewNotification {
  kind: string;
  title: string;
  body?: string | null;
  conferenceId?: string | null;
  submissionId?: string | null;
  link?: string | null;
}

/**
 * Writes in-app notifications (the bell). Always called inside the transaction of the change it
 * reports, so a notification exists exactly when the change does. Replaces the old notify_*
 * database triggers.
 */
@Injectable()
export class NotificationsService {
  async notify(
    executor: Executor,
    userIds: readonly string[],
    notification: NewNotification,
  ): Promise<void> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) {
      return;
    }
    await executor.insert(notifications).values(
      unique.map((userId) => ({
        userId,
        kind: notification.kind,
        title: notification.title,
        body: notification.body ?? null,
        conferenceId: notification.conferenceId ?? null,
        submissionId: notification.submissionId ?? null,
        link: notification.link ?? null,
      })),
    );
  }

  /** Every active chair and track chair of the conference. */
  async notifyChairs(
    executor: Executor,
    conferenceId: string,
    notification: Omit<NewNotification, 'conferenceId'>,
  ): Promise<void> {
    const chairs = await executor
      .select({ userId: conferenceMembers.userId })
      .from(conferenceMembers)
      .where(
        and(
          eq(conferenceMembers.conferenceId, conferenceId),
          eq(conferenceMembers.status, 'active'),
          inArray(conferenceMembers.role, ['chair', 'track_chair']),
        ),
      );
    await this.notify(
      executor,
      chairs.flatMap((c) => (c.userId ? [c.userId] : [])),
      { ...notification, conferenceId },
    );
  }

  async notifySuperAdmins(
    executor: Executor,
    notification: NewNotification,
  ): Promise<void> {
    const admins = await executor
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.isSuperAdmin, true), eq(users.status, 'active')));
    await this.notify(
      executor,
      admins.map((a) => a.id),
      notification,
    );
  }
}
