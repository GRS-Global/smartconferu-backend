import { randomInt } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import type { Env } from '../../config/env.js';
import { decrypt, encrypt, hmac } from '../../core/auth/secrets.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Executor } from '../../core/database/database.types.js';
import {
  mfaRecoveryCodes,
  userMfa,
  users,
} from '../../core/database/schema/index.js';
import { AppException, ErrorCode } from '../../core/errors/app.exception.js';

const ISSUER = 'Smartconferu';
const PERIOD_SECONDS = 30;
const RECOVERY_CODE_COUNT = 10;
// No 0/o, 1/l/i: easy to read back from paper.
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const MAX_FAILED_CODES = 5;
const LOCK_MINUTES = 15;

export interface TotpSetup {
  /** For manual entry in the authenticator app. */
  secret: string;
  /** Render as a QR code. */
  otpauthUrl: string;
}

/**
 * Authenticator-app (TOTP, RFC 6238) second factor and its recovery codes. Codes are accepted
 * one step either side of now (clock drift), and never twice.
 */
@Injectable()
export class MfaService {
  private readonly key: Buffer;
  private readonly hashSecret: string;

  constructor(
    private readonly database: DatabaseService,
    config: ConfigService<Env, true>,
  ) {
    this.key = Buffer.from(
      config.get('MFA_ENCRYPTION_KEY', { infer: true }),
      'base64',
    );
    this.hashSecret = config.get('TOKEN_HASH_SECRET', { infer: true });
  }

  async isEnabled(
    userId: string,
    executor: Executor = this.database.db,
  ): Promise<boolean> {
    const [row] = await executor
      .select({ enabledAt: userMfa.enabledAt })
      .from(userMfa)
      .where(eq(userMfa.userId, userId));
    return Boolean(row?.enabledAt);
  }

  /** Starts (or restarts) setup with a fresh secret; MFA stays off until confirmed with a code. */
  async beginSetup(userId: string, label: string): Promise<TotpSetup> {
    if (await this.isEnabled(userId)) {
      throw new AppException(
        HttpStatus.CONFLICT,
        ErrorCode.CONFLICT,
        'Two-step verification is already on. Turn it off first to set up a new app.',
      );
    }
    const secret = new Secret({ size: 20 }).base32;
    const sealed = encrypt(this.key, secret);
    await this.database.db
      .insert(userMfa)
      .values({ userId, totpSecret: sealed })
      .onConflictDoUpdate({
        target: userMfa.userId,
        set: { totpSecret: sealed, lastUsedStep: null, failedAttempts: 0 },
      });
    return { secret, otpauthUrl: this.totp(secret, label).toString() };
  }

  /** Confirms setup with a first code; returns the recovery codes (shown once). */
  async enable(userId: string, code: string): Promise<string[]> {
    return this.database.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(userMfa)
        .where(eq(userMfa.userId, userId))
        .for('update');
      if (!row || row.enabledAt) {
        throw AppException.validation(
          'Start setting up two-step verification first.',
        );
      }
      const step = this.matchStep(row.totpSecret, code, row.lastUsedStep);
      if (step === null) {
        throw invalidCode();
      }
      await tx
        .update(userMfa)
        .set({ enabledAt: new Date(), lastUsedStep: step, failedAttempts: 0 })
        .where(eq(userMfa.userId, userId));
      return this.replaceRecoveryCodes(userId, tx);
    });
  }

  async disable(
    userId: string,
    executor: Executor = this.database.db,
  ): Promise<void> {
    await executor
      .delete(mfaRecoveryCodes)
      .where(eq(mfaRecoveryCodes.userId, userId));
    await executor.delete(userMfa).where(eq(userMfa.userId, userId));
  }

  async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    return this.database.transaction((tx) =>
      this.replaceRecoveryCodes(userId, tx),
    );
  }

  /**
   * Checks a code from the app, or a recovery code (which is then used up). Wrong codes count
   * towards a 15-minute lock of the account, like wrong passwords.
   */
  async verify(
    userId: string,
    code: string,
  ): Promise<{ via: 'totp' | 'recovery_code' }> {
    return this.database
      .transaction(async (tx) => {
        const [account] = await tx
          .select({ lockedUntil: users.lockedUntil })
          .from(users)
          .where(eq(users.id, userId));
        if (
          account?.lockedUntil &&
          account.lockedUntil.getTime() > Date.now()
        ) {
          throw new AppException(
            HttpStatus.TOO_MANY_REQUESTS,
            ErrorCode.AUTH_ACCOUNT_LOCKED,
            'Too many wrong codes. Try again in 15 minutes.',
          );
        }
        const [row] = await tx
          .select()
          .from(userMfa)
          .where(eq(userMfa.userId, userId))
          .for('update');
        if (!row?.enabledAt) {
          throw invalidCode();
        }

        const trimmed = code.trim();
        if (/^\d{6}$/.test(trimmed)) {
          const step = this.matchStep(
            row.totpSecret,
            trimmed,
            row.lastUsedStep,
          );
          if (step !== null) {
            await tx
              .update(userMfa)
              .set({ lastUsedStep: step, failedAttempts: 0 })
              .where(eq(userMfa.userId, userId));
            return { via: 'totp' as const };
          }
        } else {
          const [used] = await tx
            .update(mfaRecoveryCodes)
            .set({ usedAt: new Date() })
            .where(
              and(
                eq(mfaRecoveryCodes.userId, userId),
                eq(mfaRecoveryCodes.codeHash, this.recoveryHash(trimmed)),
                isNull(mfaRecoveryCodes.usedAt),
              ),
            )
            .returning({ id: mfaRecoveryCodes.id });
          if (used) {
            await tx
              .update(userMfa)
              .set({ failedAttempts: 0 })
              .where(eq(userMfa.userId, userId));
            return { via: 'recovery_code' as const };
          }
        }

        const failed = row.failedAttempts + 1;
        await tx
          .update(userMfa)
          .set({ failedAttempts: failed >= MAX_FAILED_CODES ? 0 : failed })
          .where(eq(userMfa.userId, userId));
        if (failed >= MAX_FAILED_CODES) {
          await tx
            .update(users)
            .set({
              lockedUntil: sql`now() + make_interval(mins => ${LOCK_MINUTES})`,
            })
            .where(eq(users.id, userId));
        }
        return null;
      })
      .then((result) => {
        // Thrown outside the transaction so the failed-attempt count is committed.
        if (!result) throw invalidCode();
        return result;
      });
  }

  async unusedRecoveryCodeCount(userId: string): Promise<number> {
    const [row] = await this.database.db
      .select({ n: sql<number>`count(*)::int` })
      .from(mfaRecoveryCodes)
      .where(
        and(
          eq(mfaRecoveryCodes.userId, userId),
          isNull(mfaRecoveryCodes.usedAt),
        ),
      );
    return row?.n ?? 0;
  }

  /** The time step `code` belongs to, or null if wrong or already used. */
  private matchStep(
    sealedSecret: string,
    code: string,
    lastUsedStep: number | null,
  ): number | null {
    const delta = this.totp(decrypt(this.key, sealedSecret)).validate({
      token: code,
      window: 1,
    });
    if (delta === null) {
      return null;
    }
    const step = Math.floor(Date.now() / 1000 / PERIOD_SECONDS) + delta;
    return lastUsedStep !== null && step <= lastUsedStep ? null : step;
  }

  private async replaceRecoveryCodes(
    userId: string,
    tx: Executor,
  ): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      const chars = Array.from(
        { length: 8 },
        () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)],
      );
      return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
    });
    await tx
      .delete(mfaRecoveryCodes)
      .where(eq(mfaRecoveryCodes.userId, userId));
    await tx
      .insert(mfaRecoveryCodes)
      .values(
        codes.map((code) => ({ userId, codeHash: this.recoveryHash(code) })),
      );
    return codes;
  }

  private recoveryHash(code: string): string {
    return hmac(
      this.hashSecret,
      `recovery:${code.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
    );
  }

  private totp(secret: string, label = 'account'): TOTP {
    return new TOTP({
      issuer: ISSUER,
      label,
      algorithm: 'SHA1',
      digits: 6,
      period: PERIOD_SECONDS,
      secret: Secret.fromBase32(secret),
    });
  }
}

const invalidCode = () =>
  new AppException(
    HttpStatus.UNAUTHORIZED,
    ErrorCode.AUTH_INVALID_CODE,
    'That code is wrong or has already been used.',
  );
