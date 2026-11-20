import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import {
  adminClaims,
  adminNotes,
  profiles,
  users,
} from '../../core/database/schema/index.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import type {
  AdminNoteResponse,
  QueueKey,
  QueueStateResponse,
} from './dto/admin-queue.dto.js';

const nameOf = (
  first: string | null,
  last: string | null,
  email: string | null,
) => [first, last].filter(Boolean).join(' ') || email || 'Unknown';

/**
 * The working state of the admin console's approval queues: who is on an item ("Assign to me",
 * "Release", "Take over") and its notes (internal, and the messages sent to the person who asked).
 */
@Injectable()
export class AdminQueueService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Every claim and note of a queue, for its list and drawers. */
  async state(queue: QueueKey): Promise<QueueStateResponse> {
    const db = this.database.db;
    const claims = await db
      .select({
        itemId: adminClaims.itemId,
        claimedAt: adminClaims.claimedAt,
        adminId: adminClaims.adminId,
        email: users.email,
        firstName: profiles.firstName,
        lastName: profiles.lastName,
      })
      .from(adminClaims)
      .innerJoin(users, eq(users.id, adminClaims.adminId))
      .leftJoin(profiles, eq(profiles.id, adminClaims.adminId))
      .where(eq(adminClaims.queue, queue));
    const notes = await this.notes(queue);
    return {
      claims: claims.map((c) => ({
        itemId: c.itemId,
        claimedAt: c.claimedAt.toISOString(),
        admin: {
          id: c.adminId,
          name: nameOf(c.firstName, c.lastName, c.email),
        },
      })),
      notes,
    };
  }

  private async notes(
    queue: QueueKey,
    itemId?: string,
  ): Promise<AdminNoteResponse[]> {
    const rows = await this.database.db
      .select({
        id: adminNotes.id,
        itemId: adminNotes.itemId,
        kind: adminNotes.kind,
        text: adminNotes.text,
        createdAt: adminNotes.createdAt,
        authorId: adminNotes.authorId,
        email: users.email,
        firstName: profiles.firstName,
        lastName: profiles.lastName,
      })
      .from(adminNotes)
      .leftJoin(users, eq(users.id, adminNotes.authorId))
      .leftJoin(profiles, eq(profiles.id, adminNotes.authorId))
      .where(
        and(
          eq(adminNotes.queue, queue),
          itemId ? eq(adminNotes.itemId, itemId) : undefined,
        ),
      )
      .orderBy(asc(adminNotes.createdAt));
    return rows.map((n) => ({
      id: n.id,
      itemId: n.itemId,
      kind: n.kind as 'note' | 'message',
      text: n.text,
      createdAt: n.createdAt.toISOString(),
      author: n.authorId
        ? { id: n.authorId, name: nameOf(n.firstName, n.lastName, n.email) }
        : null,
    }));
  }

  /** "Assign to me" (or "Take over" from another admin). */
  async claim(
    admin: AuthUser,
    queue: QueueKey,
    itemId: string,
    client: ClientInfo,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx
        .insert(adminClaims)
        .values({ queue, itemId, adminId: admin.id })
        .onConflictDoUpdate({
          target: [adminClaims.queue, adminClaims.itemId],
          set: { adminId: admin.id, claimedAt: new Date() },
        });
      await this.audit.record(
        {
          action: 'admin.queue_item_claimed',
          actorId: admin.id,
          entityType: queue,
          entityId: itemId,
          client,
        },
        tx,
      );
    });
  }

  /** "Release": nobody is on the item any more. */
  async release(
    admin: AuthUser,
    queue: QueueKey,
    itemId: string,
    client: ClientInfo,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx
        .delete(adminClaims)
        .where(
          and(eq(adminClaims.queue, queue), eq(adminClaims.itemId, itemId)),
        );
      await this.audit.record(
        {
          action: 'admin.queue_item_released',
          actorId: admin.id,
          entityType: queue,
          entityId: itemId,
          client,
        },
        tx,
      );
    });
  }

  /** An internal note: only admins see it. */
  async addNote(
    admin: AuthUser,
    queue: QueueKey,
    itemId: string,
    text: string,
  ): Promise<AdminNoteResponse> {
    const [row] = await this.database.db
      .insert(adminNotes)
      .values({ queue, itemId, kind: 'note', authorId: admin.id, text })
      .returning({ id: adminNotes.id });
    const notes = await this.notes(queue, itemId);
    return notes.find((n) => n.id === row.id)!;
  }
}
