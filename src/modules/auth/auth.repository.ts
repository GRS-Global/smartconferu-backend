import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { normalizeEmail } from '../../core/auth/secrets.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Executor } from '../../core/database/database.types.js';
import {
  profileDetails,
  profiles,
  users,
} from '../../core/database/schema/index.js';

export type UserRow = typeof users.$inferSelect;

export interface NewAccount {
  /** Null for an ORCID sign-in until the user adds and confirms an address. */
  email: string | null;
  passwordHash: string | null;
  emailVerified: boolean;
  firstName: string;
  lastName: string;
  designation?: string | null;
  affiliation?: string | null;
  country?: string | null;
  /** The Terms version the user accepted while signing up; recorded with the current time. */
  termsVersion?: string | null;
  /** Private profile details from the registration form (profile_details.data). */
  details?: Record<string, unknown>;
}

/** Account rows (users + the profile created with them). */
@Injectable()
export class AuthRepository {
  constructor(private readonly database: DatabaseService) {}

  async findByEmail(
    email: string,
    executor: Executor = this.database.db,
  ): Promise<UserRow | undefined> {
    const [row] = await executor
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${normalizeEmail(email)}`);
    return row;
  }

  async findById(
    id: string,
    executor: Executor = this.database.db,
  ): Promise<UserRow | undefined> {
    const [row] = await executor.select().from(users).where(eq(users.id, id));
    return row;
  }

  /** Creates the account with its profile and private details. */
  async create(account: NewAccount, executor: Executor): Promise<UserRow> {
    const [user] = await executor
      .insert(users)
      .values({
        email: account.email ? normalizeEmail(account.email) : null,
        passwordHash: account.passwordHash,
        emailVerifiedAt: account.emailVerified ? new Date() : null,
        termsVersion: account.termsVersion ?? null,
        termsAcceptedAt: account.termsVersion ? new Date() : null,
      })
      .returning();
    await executor.insert(profiles).values({
      id: user.id,
      firstName: account.firstName,
      lastName: account.lastName,
      designation: account.designation ?? null,
      affiliation: account.affiliation ?? null,
      country: account.country ?? null,
    });
    await executor
      .insert(profileDetails)
      .values({ userId: user.id, data: account.details ?? {} });
    return user;
  }

  async update(
    id: string,
    values: Partial<
      Pick<
        UserRow,
        | 'passwordHash'
        | 'emailVerifiedAt'
        | 'failedSignInCount'
        | 'lockedUntil'
        | 'lastSignInAt'
        | 'termsAcceptedAt'
        | 'termsVersion'
      >
    >,
    executor: Executor = this.database.db,
  ): Promise<void> {
    await executor.update(users).set(values).where(eq(users.id, id));
  }

  /** Counts a failed password attempt; locks the account once `maxAttempts` is reached. */
  async recordFailedSignIn(
    id: string,
    maxAttempts: number,
    lockMinutes: number,
  ): Promise<void> {
    await this.database.db
      .update(users)
      .set({
        failedSignInCount: sql`case when ${users.failedSignInCount} + 1 >= ${maxAttempts} then 0 else ${users.failedSignInCount} + 1 end`,
        lockedUntil: sql`case when ${users.failedSignInCount} + 1 >= ${maxAttempts}
          then now() + make_interval(mins => ${lockMinutes}) else ${users.lockedUntil} end`,
      })
      .where(eq(users.id, id));
  }
}
