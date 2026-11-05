import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import bcrypt from 'bcryptjs';

// argon2id (the library default) with OWASP's recommended settings: 19 MiB, 2 passes.
const ARGON2 = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};
const BCRYPT_PREFIX = /^\$2[aby]\$/;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

@Injectable()
export class PasswordService {
  /** A fixed hash to verify against when the account doesn't exist, so timing doesn't reveal it. */
  private readonly dummyHash = hash('not-a-real-password', ARGON2);

  hash(password: string): Promise<string> {
    return hash(password, ARGON2);
  }

  /**
   * Checks a password against a stored hash: argon2id, or bcrypt for accounts carried over from
   * the old system. `needsRehash` asks the caller to replace a bcrypt hash with argon2id.
   */
  async verify(
    storedHash: string | null,
    password: string,
  ): Promise<{ valid: boolean; needsRehash: boolean }> {
    if (!storedHash) {
      await verify(await this.dummyHash, password);
      return { valid: false, needsRehash: false };
    }
    if (BCRYPT_PREFIX.test(storedHash)) {
      const valid = await bcrypt.compare(password, storedHash);
      return { valid, needsRehash: valid };
    }
    return { valid: await verify(storedHash, password), needsRehash: false };
  }

  /** Why a new password is not acceptable, or null if it is. */
  weakness(password: string, email?: string | null): string | null {
    if (password.length < PASSWORD_MIN_LENGTH) {
      return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
      return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
    }
    if (email && password.trim().toLowerCase() === email.trim().toLowerCase()) {
      return 'Your password must not be your email address.';
    }
    if (new Set(password).size < 4) {
      return 'Use a less repetitive password.';
    }
    return null;
  }
}
