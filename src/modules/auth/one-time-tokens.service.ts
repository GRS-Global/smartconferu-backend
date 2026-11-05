import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Env } from '../../config/env.js';
import {
  hmac,
  normalizeEmail,
  randomCode,
  randomToken,
  safeEqual,
  sha256,
} from '../../core/auth/secrets.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Executor } from '../../core/database/database.types.js';
import { authTokens } from '../../core/database/schema/index.js';

export type LinkPurpose = 'verify_email' | 'reset_password' | 'change_email';
export type CodePurpose = 'login_code' | 'merge_account';

/** Wrong guesses allowed per code before it stops working. */
const MAX_CODE_ATTEMPTS = 5;

const isUniqueViolation = (error: unknown): boolean =>
  (error as { cause?: { code?: string } })?.cause?.code === '23505';

export interface ConsumedToken {
  userId: string | null;
  email: string;
}

/**
 * Single-use secrets sent by email. Links carry a long random token (looked up by its SHA-256);
 * codes are 6 digits (keyed hash, limited attempts). Issuing a new one cancels the previous
 * unused ones for the same email and purpose.
 */
@Injectable()
export class OneTimeTokensService {
  private readonly secret: string;

  constructor(
    private readonly database: DatabaseService,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('TOKEN_HASH_SECRET', { infer: true });
  }

  async issueLink(
    purpose: LinkPurpose,
    email: string,
    userId: string | null,
    ttlMinutes: number,
    executor: Executor = this.database.db,
  ): Promise<string> {
    const token = randomToken();
    await this.store(
      executor,
      purpose,
      email,
      userId,
      sha256(token),
      ttlMinutes,
    );
    return token;
  }

  /** Marks the link used and returns who it was for; null if unknown, used or expired. */
  async consumeLink(
    purpose: LinkPurpose,
    token: string,
    executor: Executor = this.database.db,
  ): Promise<ConsumedToken | null> {
    const [row] = await executor
      .update(authTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(authTokens.tokenHash, sha256(token)),
          eq(authTokens.purpose, purpose),
          isNull(authTokens.consumedAt),
          gt(authTokens.expiresAt, new Date()),
        ),
      )
      .returning({ userId: authTokens.userId, email: authTokens.email });
    return row ?? null;
  }

  async issueCode(
    purpose: CodePurpose,
    email: string,
    userId: string | null,
    ttlMinutes: number,
  ): Promise<string> {
    // A code can repeat an earlier one for the same email (1 in a million), which the unique
    // hash index refuses; just draw again.
    for (let attempt = 1; ; attempt++) {
      const code = randomCode();
      try {
        await this.store(
          this.database.db,
          purpose,
          email,
          userId,
          this.codeHash(purpose, email, code),
          ttlMinutes,
        );
        return code;
      } catch (error) {
        if (attempt >= 3 || !isUniqueViolation(error)) throw error;
      }
    }
  }

  /** Checks a typed-in code against the latest one sent to this email. */
  verifyCode(
    purpose: CodePurpose,
    email: string,
    code: string,
  ): Promise<ConsumedToken | null> {
    const normalized = normalizeEmail(email);
    return this.database.transaction(async (tx) => {
      const [latest] = await tx
        .select()
        .from(authTokens)
        .where(
          and(
            sql`lower(${authTokens.email}) = ${normalized}`,
            eq(authTokens.purpose, purpose),
            isNull(authTokens.consumedAt),
            gt(authTokens.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(authTokens.createdAt))
        .limit(1)
        .for('update');
      if (!latest || latest.attempts >= MAX_CODE_ATTEMPTS) {
        return null;
      }
      if (
        !safeEqual(latest.tokenHash, this.codeHash(purpose, normalized, code))
      ) {
        await tx
          .update(authTokens)
          .set({ attempts: latest.attempts + 1 })
          .where(eq(authTokens.id, latest.id));
        return null;
      }
      await tx
        .update(authTokens)
        .set({ consumedAt: new Date() })
        .where(eq(authTokens.id, latest.id));
      return { userId: latest.userId, email: latest.email };
    });
  }

  private codeHash(purpose: CodePurpose, email: string, code: string): string {
    // Email and purpose are part of the input, so equal codes for different people don't collide.
    return hmac(this.secret, `${purpose}:${normalizeEmail(email)}:${code}`);
  }

  private async store(
    executor: Executor,
    purpose: LinkPurpose | CodePurpose,
    email: string,
    userId: string | null,
    tokenHash: string,
    ttlMinutes: number,
  ): Promise<void> {
    const normalized = normalizeEmail(email);
    await executor
      .update(authTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          sql`lower(${authTokens.email}) = ${normalized}`,
          eq(authTokens.purpose, purpose),
          isNull(authTokens.consumedAt),
        ),
      );
    await executor.insert(authTokens).values({
      userId,
      email: normalized,
      purpose,
      tokenHash,
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
    });
  }
}
