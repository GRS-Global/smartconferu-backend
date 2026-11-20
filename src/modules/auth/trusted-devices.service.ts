import { Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { randomToken, sha256 } from '../../core/auth/secrets.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Executor } from '../../core/database/database.types.js';
import { trustedDevices } from '../../core/database/schema/index.js';
import type { ClientInfo } from '../../core/http/client-info.js';

/** How long "Trust this device" skips the emailed admin sign-in code. */
export const TRUSTED_DEVICE_DAYS = 14;

/**
 * "Trust this device" for the admin console's emailed second step. The browser keeps a random
 * token in an httpOnly cookie; only its hash is stored, tied to one user, so a cookie never
 * vouches for anyone else. Every trust can be taken back.
 */
@Injectable()
export class TrustedDevicesService {
  constructor(private readonly database: DatabaseService) {}

  /** Trusts this browser for the user; the token goes in the cookie. */
  async trust(
    userId: string,
    client: ClientInfo,
    executor: Executor = this.database.db,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken();
    const expiresAt = new Date(Date.now() + TRUSTED_DEVICE_DAYS * 86_400_000);
    await executor.insert(trustedDevices).values({
      userId,
      tokenHash: sha256(token),
      expiresAt,
      userAgent: client.userAgent,
      ipAddress: client.ipAddress,
    });
    return { token, expiresAt };
  }

  /** True when the token is a live trust for this very user (and notes that it was used). */
  async isTrusted(
    userId: string,
    token: string | undefined,
    executor: Executor = this.database.db,
  ): Promise<boolean> {
    if (!token) {
      return false;
    }
    const rows = await executor
      .update(trustedDevices)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(trustedDevices.tokenHash, sha256(token)),
          eq(trustedDevices.userId, userId),
          isNull(trustedDevices.revokedAt),
          gt(trustedDevices.expiresAt, new Date()),
        ),
      )
      .returning({ id: trustedDevices.id });
    return rows.length > 0;
  }

  /** "Forget this device": ends the trust this cookie carries, whoever it belongs to. */
  async forget(token: string | undefined): Promise<void> {
    if (!token) {
      return;
    }
    await this.database.db
      .update(trustedDevices)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(trustedDevices.tokenHash, sha256(token)),
          isNull(trustedDevices.revokedAt),
        ),
      );
  }

  /** Ends every trust of a user (signed out everywhere, password changed or reset). */
  async forgetAllForUser(
    userId: string,
    executor: Executor = this.database.db,
  ): Promise<void> {
    await executor
      .update(trustedDevices)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(trustedDevices.userId, userId),
          isNull(trustedDevices.revokedAt),
        ),
      );
  }
}
