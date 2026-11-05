import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import type { Executor } from '../database/database.types.js';
import { auditLog } from '../database/schema/index.js';
import type { ClientInfo } from '../http/client-info.js';

export interface AuditEntry {
  /** Dotted verb, e.g. "auth.sign_in". */
  action: string;
  actorId?: string | null;
  entityType?: string;
  entityId?: string;
  client?: ClientInfo;
  /** Context worth keeping. Never secrets: no passwords, tokens or codes. */
  data?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(private readonly database: DatabaseService) {}

  /** Records an action; pass the transaction to make the record part of it. */
  async record(
    entry: AuditEntry,
    executor: Executor = this.database.db,
  ): Promise<void> {
    await executor.insert(auditLog).values({
      action: entry.action,
      actorId: entry.actorId ?? null,
      entityType: entry.entityType,
      entityId: entry.entityId,
      ipAddress: entry.client?.ipAddress,
      userAgent: entry.client?.userAgent,
      data: entry.data ?? {},
    });
  }
}
