import { randomUUID } from 'node:crypto';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type postgres from 'postgres';
import type { Env } from '../../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { PG_CLIENT } from '../database/database.types.js';
import { notifications } from '../database/schema/index.js';
import { type Cursor, encodeCursor, keyset } from '../http/pagination.js';
import {
  type NotificationView,
  toNotificationView,
} from '../notifications/notification.view.js';

/** The Postgres channel live events travel on between API instances. */
const CHANNEL = 'sc_live_events';
/** Notification ids per NOTIFY message (a payload must stay under 8000 bytes). */
const IDS_PER_MESSAGE = 100;
/** Open streams per user (tabs, devices); the oldest is closed when one more opens. */
export const MAX_STREAMS_PER_USER = 5;
/** Missed notifications sent after a reconnect, at most. */
const CATCH_UP_LIMIT = 100;

export interface LiveEvent {
  /** Resume point: the stream's `id:`, sent back as Last-Event-ID after a reconnect. */
  id?: string;
  type: 'notification' | 'ready';
  data: unknown;
}

export interface Subscriber {
  userId: string;
  send(event: LiveEvent): void;
  /** Ends the stream (too many open, or the server is stopping). */
  close(reason: 'replaced' | 'shutdown'): void;
}

const cursorOf = (n: { createdAt: Date; id: string }): Cursor => ({
  at: n.createdAt,
  id: n.id,
});

/**
 * Live events for the signed-in user's open streams (GET /me/events, Server-Sent Events). For now
 * one kind: a new bell notification, pushed the moment the change that made it is saved.
 *
 * NotificationsService calls publish() after the transaction commits. This instance pushes to its
 * own streams; with REALTIME_FANOUT the ids also go out on Postgres NOTIFY, and every other
 * instance (LISTEN) pushes to its streams, so it doesn't matter which instance a user is
 * connected to. Events carry the notification as the bell shows it, plus the unread count.
 */
@Injectable()
export class LiveEventsService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(LiveEventsService.name);
  private readonly instanceId = randomUUID();
  private readonly fanout: boolean;
  private readonly streams = new Map<string, Set<Subscriber>>();
  private listening?: { unlisten: () => Promise<void> };

  constructor(
    private readonly database: DatabaseService,
    @Inject(PG_CLIENT) private readonly client: postgres.Sql,
    config: ConfigService<Env, true>,
  ) {
    this.fanout = config.get('REALTIME_FANOUT', { infer: true });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.fanout) {
      return;
    }
    this.listening = await this.client.listen(CHANNEL, (payload) => {
      try {
        const message = JSON.parse(payload) as { from: string; ids: string[] };
        if (message.from !== this.instanceId) {
          void this.deliver(message.ids);
        }
      } catch (error) {
        this.logger.warn({ err: error }, 'Unreadable live event');
      }
    });
  }

  /** Streams end before the HTTP server closes, or it would wait for them. */
  async beforeApplicationShutdown(): Promise<void> {
    for (const set of this.streams.values()) {
      for (const subscriber of set) {
        subscriber.close('shutdown');
      }
    }
    this.streams.clear();
    await this.listening?.unlisten().catch(() => undefined);
  }

  /** How many streams are open (for tests and health). */
  get openStreams(): number {
    let n = 0;
    for (const set of this.streams.values()) {
      n += set.size;
    }
    return n;
  }

  /**
   * Adds a stream. When the user already has MAX_STREAMS_PER_USER open, the oldest is closed.
   * Returns the function that removes it.
   */
  subscribe(subscriber: Subscriber): () => void {
    const set = this.streams.get(subscriber.userId) ?? new Set<Subscriber>();
    this.streams.set(subscriber.userId, set);
    set.add(subscriber);
    if (set.size > MAX_STREAMS_PER_USER) {
      const oldest = set.values().next().value!;
      set.delete(oldest);
      oldest.close('replaced');
    }
    return () => {
      set.delete(subscriber);
      if (set.size === 0 && this.streams.get(subscriber.userId) === set) {
        this.streams.delete(subscriber.userId);
      }
    };
  }

  /** New notifications were saved: push them to their users' streams, here and on every instance. */
  async publish(notificationIds: readonly string[]): Promise<void> {
    if (notificationIds.length === 0) {
      return;
    }
    await this.deliver(notificationIds);
    if (this.fanout) {
      for (let i = 0; i < notificationIds.length; i += IDS_PER_MESSAGE) {
        await this.client.notify(
          CHANNEL,
          JSON.stringify({
            from: this.instanceId,
            ids: notificationIds.slice(i, i + IDS_PER_MESSAGE),
          }),
        );
      }
    }
  }

  /** The first event of a stream: the unread count, so the bell is right at once. */
  async ready(userId: string): Promise<LiveEvent> {
    return { type: 'ready', data: { unread: await this.unread(userId) } };
  }

  /** The user's notifications since `cursor` (a reconnect), oldest first. */
  async catchUp(userId: string, cursor: Cursor): Promise<LiveEvent[]> {
    const order = keyset(
      notifications.createdAt,
      notifications.id,
      cursor,
      'oldest-first',
    );
    const rows = await this.database.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), order.where))
      .orderBy(...order.orderBy)
      .limit(CATCH_UP_LIMIT);
    if (rows.length === 0) {
      return [];
    }
    const unread = await this.unread(userId);
    return rows.map((row) => this.event(toNotificationView(row), unread));
  }

  /** Sends these notifications to whichever of their users have a stream on this instance. */
  private async deliver(ids: readonly string[]): Promise<void> {
    const users = [...this.streams.keys()];
    if (users.length === 0) {
      return;
    }
    const rows = await this.database.db
      .select()
      .from(notifications)
      .where(
        and(
          inArray(notifications.id, [...ids]),
          inArray(notifications.userId, users),
        ),
      )
      .orderBy(asc(notifications.createdAt), asc(notifications.id));
    const unread = new Map<string, number>();
    for (const row of rows) {
      if (!unread.has(row.userId)) {
        unread.set(row.userId, await this.unread(row.userId));
      }
      const event = this.event(
        toNotificationView(row),
        unread.get(row.userId)!,
      );
      for (const subscriber of this.streams.get(row.userId) ?? []) {
        subscriber.send(event);
      }
    }
  }

  private event(notification: NotificationView, unread: number): LiveEvent {
    return {
      id: encodeCursor(
        cursorOf({
          createdAt: new Date(notification.createdAt),
          id: notification.id,
        }),
      ),
      type: 'notification',
      data: { notification, unread },
    };
  }

  private async unread(userId: string): Promise<number> {
    const [row] = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(eq(notifications.userId, userId), isNull(notifications.readAt)),
      );
    return row?.count ?? 0;
  }
}
