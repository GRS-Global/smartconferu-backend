import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Executor } from '../../core/database/database.types.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { MeResponse, MyConferenceResponse } from './dto/me.response.js';
import type { UpdateMeDto } from './dto/update-me.dto.js';
import { type ProfileUpdate, UsersRepository } from './users.repository.js';

/** The signed-in user's own account. Every method only ever touches the caller's own rows. */
@Injectable()
export class UsersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly users: UsersRepository,
  ) {}

  getMe(user: AuthUser): Promise<MeResponse> {
    return this.loadMe(this.database.db, user.id);
  }

  updateMe(user: AuthUser, dto: UpdateMeDto): Promise<MeResponse> {
    // A profile may only point at a photo in the user's own folder.
    if (dto.photoPath && !dto.photoPath.startsWith(`${user.id}/`)) {
      throw AppException.validation(
        'The photo must be uploaded to your own folder.',
        [{ field: 'photoPath', errors: ['must start with your user id'] }],
      );
    }

    const { details, ...fields } = dto;
    const columns: ProfileUpdate = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    );

    return this.database.transaction(async (tx) => {
      if (
        Object.keys(columns).length > 0 &&
        !(await this.users.updateProfile(tx, user.id, columns))
      ) {
        throw AppException.notFound('Your profile');
      }
      if (
        details !== undefined &&
        !(await this.users.updateDetails(tx, user.id, details))
      ) {
        throw AppException.notFound('Your profile');
      }
      return this.loadMe(tx, user.id);
    });
  }

  /** Records acceptance of a Terms version (a first provider sign-in, or a newer version). */
  async acceptTerms(user: AuthUser, version: string): Promise<MeResponse> {
    return this.database.transaction(async (tx) => {
      await this.users.acceptTerms(tx, user.id, version);
      return this.loadMe(tx, user.id);
    });
  }

  listMyConferences(user: AuthUser): Promise<MyConferenceResponse[]> {
    return this.users.listConferences(this.database.db, user.id);
  }

  private async loadMe(
    executor: Executor,
    userId: string,
  ): Promise<MeResponse> {
    const profile = await this.users.findProfile(executor, userId);
    if (!profile) {
      throw AppException.notFound('Your profile');
    }
    const details = await this.users.findDetails(executor, userId);
    return {
      id: profile.id,
      email: profile.email,
      emailVerified: profile.emailVerifiedAt !== null,
      firstName: profile.firstName,
      lastName: profile.lastName,
      designation: profile.designation,
      affiliation: profile.affiliation,
      country: profile.country,
      orcidId: profile.orcidId,
      photoPath: profile.photoPath,
      isSuperAdmin: profile.isSuperAdmin,
      termsAcceptedAt: profile.termsAcceptedAt?.toISOString() ?? null,
      termsVersion: profile.termsVersion,
      details: details ?? {},
      createdAt: profile.createdAt.toISOString(),
      updatedAt: profile.updatedAt.toISOString(),
    };
  }
}
