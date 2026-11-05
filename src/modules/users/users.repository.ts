import { Injectable } from '@nestjs/common';
import { and, asc, eq, getTableColumns, ne } from 'drizzle-orm';
import type { Executor } from '../../core/database/database.types.js';
import {
  conferenceMembers,
  conferences,
  profileDetails,
  profiles,
  users,
} from '../../core/database/schema/index.js';

export type ProfileRow = typeof profiles.$inferSelect & {
  email: string | null;
  emailVerifiedAt: Date | null;
  isSuperAdmin: boolean;
  termsAcceptedAt: Date | null;
  termsVersion: string | null;
};
export type ProfileUpdate = Partial<
  Pick<
    typeof profiles.$inferInsert,
    | 'firstName'
    | 'lastName'
    | 'designation'
    | 'affiliation'
    | 'country'
    | 'orcidId'
    | 'photoPath'
  >
>;

/** Database access for the users module. Pass a transaction to make a call part of it. */
@Injectable()
export class UsersRepository {
  async findProfile(
    tx: Executor,
    userId: string,
  ): Promise<ProfileRow | undefined> {
    const [row] = await tx
      .select({
        ...getTableColumns(profiles),
        email: users.email,
        emailVerifiedAt: users.emailVerifiedAt,
        isSuperAdmin: users.isSuperAdmin,
        termsAcceptedAt: users.termsAcceptedAt,
        termsVersion: users.termsVersion,
      })
      .from(profiles)
      .innerJoin(users, eq(users.id, profiles.id))
      .where(eq(profiles.id, userId));
    return row;
  }

  async findDetails(
    tx: Executor,
    userId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const [row] = await tx
      .select({ data: profileDetails.data })
      .from(profileDetails)
      .where(eq(profileDetails.userId, userId));
    return row?.data as Record<string, unknown> | undefined;
  }

  /** Returns false if no row was updated (the profile does not exist). */
  async updateProfile(
    tx: Executor,
    userId: string,
    values: ProfileUpdate,
  ): Promise<boolean> {
    const rows = await tx
      .update(profiles)
      .set(values)
      .where(eq(profiles.id, userId))
      .returning({ id: profiles.id });
    return rows.length > 0;
  }

  async updateDetails(
    tx: Executor,
    userId: string,
    data: Record<string, unknown>,
  ): Promise<boolean> {
    const rows = await tx
      .update(profileDetails)
      .set({ data })
      .where(eq(profileDetails.userId, userId))
      .returning({ userId: profileDetails.userId });
    return rows.length > 0;
  }

  /** Records that the user accepted `version` of the Terms, now. */
  async acceptTerms(
    tx: Executor,
    userId: string,
    version: string,
  ): Promise<void> {
    await tx
      .update(users)
      .set({ termsVersion: version, termsAcceptedAt: new Date() })
      .where(eq(users.id, userId));
  }

  listConferences(tx: Executor, userId: string) {
    return tx
      .select({
        conferenceId: conferences.id,
        slug: conferences.slug,
        acronym: conferences.acronym,
        title: conferences.title,
        conferenceStatus: conferences.status,
        role: conferenceMembers.role,
        memberStatus: conferenceMembers.status,
      })
      .from(conferenceMembers)
      .innerJoin(
        conferences,
        eq(conferences.id, conferenceMembers.conferenceId),
      )
      .where(
        and(
          eq(conferenceMembers.userId, userId),
          ne(conferenceMembers.status, 'removed'),
        ),
      )
      .orderBy(asc(conferences.acronym), asc(conferenceMembers.role));
  }
}
