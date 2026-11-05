import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Env } from '../../config/env.js';
import { randomToken, sha256 } from '../../core/auth/secrets.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Executor } from '../../core/database/database.types.js';
import { sessions } from '../../core/database/schema/index.js';
import type { ClientInfo } from '../../core/http/client-info.js';

/** Two tabs refreshing at once both present the same token; the slower one is not an attack. */
const CONCURRENT_REFRESH_GRACE_MS = 30_000;

export interface IssuedRefreshToken {
  userId: string;
  sessionId: string;
  refreshToken: string;
  expiresAt: Date;
  /** The family passed a second factor at sign-in; carried across refreshes. */
  mfaVerified: boolean;
}

/** A signed-in device, as shown in "Where you're signed in". */
export interface ActiveSession {
  id: string;
  signedInAt: Date;
  lastActiveAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  ipAddress: string | null;
  mfaVerified: boolean;
}

export type RotateResult =
  | { ok: true; token: IssuedRefreshToken }
  | {
      ok: false;
      reason: 'unknown' | 'expired' | 'revoked' | 'concurrent' | 'reused';
      userId?: string;
      sessionId?: string;
    };

/**
 * Refresh tokens and the session families they belong to. A refresh token works once: using it
 * returns a new one in the same family. Presenting an already-rotated token (after the grace
 * period) means someone kept a copy, so the whole family is revoked.
 */
@Injectable()
export class SessionsService {
  private readonly ttlMs: number;

  constructor(
    private readonly database: DatabaseService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlMs =
      config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }) * 86_400_000;
  }

  /** Starts a new session family (a sign-in). */
  start(
    userId: string,
    client: ClientInfo,
    executor: Executor = this.database.db,
    mfaVerified = false,
  ): Promise<IssuedRefreshToken> {
    return this.insert(
      executor,
      userId,
      randomUUID(),
      client,
      mfaVerified ? new Date() : null,
    );
  }

  /** Records that a session passed a second factor (e.g. right after turning MFA on). */
  async markMfaVerified(
    familyId: string,
    executor: Executor = this.database.db,
  ): Promise<void> {
    await executor
      .update(sessions)
      .set({ mfaVerifiedAt: new Date() })
      .where(and(eq(sessions.familyId, familyId), isNull(sessions.revokedAt)));
  }

  /** The user's signed-in devices: one entry per family with a usable refresh token. */
  async listActive(userId: string): Promise<ActiveSession[]> {
    const rows = await this.database.db
      .select({
        id: sessions.familyId,
        signedInAt: sql<Date>`min(${sessions.createdAt})`.mapWith(
          sessions.createdAt,
        ),
        lastActiveAt: sql<Date>`max(${sessions.createdAt})`.mapWith(
          sessions.createdAt,
        ),
        expiresAt: sql<Date>`max(${sessions.expiresAt})`.mapWith(
          sessions.expiresAt,
        ),
        userAgent: sql<
          string | null
        >`(array_agg(${sessions.userAgent} order by ${sessions.createdAt} desc))[1]`,
        ipAddress: sql<
          string | null
        >`(array_agg(${sessions.ipAddress} order by ${sessions.createdAt} desc))[1]`,
        mfaVerified: sql<boolean>`bool_or(${sessions.mfaVerifiedAt} is not null)`,
      })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .groupBy(sessions.familyId)
      .having(
        sql`bool_or(${sessions.revokedAt} is null and ${sessions.rotatedAt} is null and ${sessions.expiresAt} > now())
            and bool_and(${sessions.revokedAt} is null)`,
      )
      .orderBy(desc(sql`max(${sessions.createdAt})`));
    return rows;
  }

  /** Ends one of the user's own sessions; false if it isn't theirs or already ended. */
  async revokeOwn(
    userId: string,
    familyId: string,
    reason: string,
  ): Promise<boolean> {
    const rows = await this.database.db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(
        and(
          eq(sessions.userId, userId),
          eq(sessions.familyId, familyId),
          isNull(sessions.revokedAt),
        ),
      )
      .returning({ id: sessions.id });
    return rows.length > 0;
  }

  rotate(refreshToken: string, client: ClientInfo): Promise<RotateResult> {
    return this.database.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.tokenHash, sha256(refreshToken)))
        .for('update');
      if (!current) {
        return { ok: false, reason: 'unknown' };
      }
      const owner = { userId: current.userId, sessionId: current.familyId };
      if (current.revokedAt) {
        return { ok: false, reason: 'revoked', ...owner };
      }
      if (current.rotatedAt) {
        if (
          Date.now() - current.rotatedAt.getTime() <
          CONCURRENT_REFRESH_GRACE_MS
        ) {
          return { ok: false, reason: 'concurrent', ...owner };
        }
        await this.revokeFamily(current.familyId, 'refresh_token_reused', tx);
        return { ok: false, reason: 'reused', ...owner };
      }
      if (current.expiresAt.getTime() <= Date.now()) {
        return { ok: false, reason: 'expired', ...owner };
      }

      await tx
        .update(sessions)
        .set({ rotatedAt: new Date() })
        .where(eq(sessions.id, current.id));
      const token = await this.insert(
        tx,
        current.userId,
        current.familyId,
        client,
        current.mfaVerifiedAt,
      );
      return { ok: true, token };
    });
  }

  /** Ends one session family (sign out on this device). */
  async revokeFamily(
    familyId: string,
    reason: string,
    executor: Executor = this.database.db,
  ): Promise<void> {
    await executor
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(sessions.familyId, familyId), isNull(sessions.revokedAt)));
  }

  /** The family a refresh token belongs to, whatever its state; null if unknown. */
  async familyOf(
    refreshToken: string,
  ): Promise<{ userId: string; familyId: string } | null> {
    const [row] = await this.database.db
      .select({ userId: sessions.userId, familyId: sessions.familyId })
      .from(sessions)
      .where(eq(sessions.tokenHash, sha256(refreshToken)));
    return row ?? null;
  }

  /** Ends every session of a user, optionally keeping one (e.g. the one changing the password). */
  async revokeAllForUser(
    userId: string,
    reason: string,
    exceptFamilyId?: string,
    executor: Executor = this.database.db,
  ): Promise<void> {
    await executor
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          exceptFamilyId ? ne(sessions.familyId, exceptFamilyId) : undefined,
        ),
      );
  }

  private async insert(
    executor: Executor,
    userId: string,
    familyId: string,
    client: ClientInfo,
    mfaVerifiedAt: Date | null = null,
  ): Promise<IssuedRefreshToken> {
    const refreshToken = randomToken();
    const expiresAt = new Date(Date.now() + this.ttlMs);
    await executor.insert(sessions).values({
      userId,
      familyId,
      tokenHash: sha256(refreshToken),
      expiresAt,
      mfaVerifiedAt,
      userAgent: client.userAgent,
      ipAddress: client.ipAddress,
    });
    return {
      userId,
      sessionId: familyId,
      refreshToken,
      expiresAt,
      mfaVerified: mfaVerifiedAt !== null,
    };
  }
}
