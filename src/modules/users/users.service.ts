import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Executor } from '../../core/database/database.types.js';
import { AppException } from '../../core/errors/app.exception.js';
import { FileStorage } from '../../core/storage/file-storage.js';
import { storagePaths } from '../../core/storage/storage-paths.js';
import type { DashboardResponse } from './dto/dashboard.response.js';
import type { MeResponse, MyConferenceResponse } from './dto/me.response.js';
import type { UpdateMeDto } from './dto/update-me.dto.js';
import { ProfileRequestsService } from '../master-data/profile-requests.service.js';
import { guardProfileEmails } from './profile-emails.js';
import { type ProfileUpdate, UsersRepository } from './users.repository.js';

/** The signed-in user's own account. Every method only ever touches the caller's own rows. */
@Injectable()
export class UsersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly users: UsersRepository,
    private readonly profileRequests: ProfileRequestsService,
    private readonly storage: FileStorage,
  ) {}

  getMe(user: AuthUser): Promise<MeResponse> {
    return this.loadMe(this.database.db, user.id);
  }

  updateMe(user: AuthUser, dto: UpdateMeDto): Promise<MeResponse> {
    // A profile may only point at a photo in the user's own folder.
    const folder = storagePaths.userFolder(user.id);
    if (
      dto.photoPath &&
      (!dto.photoPath.startsWith(folder) || dto.photoPath.includes('..'))
    ) {
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
      // A replaced or removed photo is deleted once the change is saved.
      if (dto.photoPath !== undefined) {
        const before = (await this.users.findProfile(tx, user.id))?.photoPath;
        if (before && before !== dto.photoPath && before.startsWith(folder)) {
          this.database.afterCommit(tx, () =>
            this.storage.delete(before).catch(() => undefined),
          );
        }
      }
      if (
        Object.keys(columns).length > 0 &&
        !(await this.users.updateProfile(tx, user.id, columns))
      ) {
        throw AppException.notFound('Your profile');
      }
      if (details !== undefined) {
        // The extra email addresses are only "verified" when the server says so.
        const account = await this.users.findProfile(tx, user.id);
        const stored = await this.users.findDetails(tx, user.id);
        const guarded = guardProfileEmails(details, stored, {
          email: account?.email ?? null,
          verified: account?.emailVerifiedAt != null,
        });
        if (!(await this.users.updateDetails(tx, user.id, guarded.details))) {
          throw AppException.notFound('Your profile');
        }
        // A new institution or society the member typed goes to the Super Admin's review queue.
        await this.profileRequests.syncFromProfile(
          tx,
          user.id,
          guarded.details,
        );
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

  /** One call for the whole "My Conferences" dashboard (conferences, roles, papers, assignments, invitations). */
  async getDashboard(user: AuthUser): Promise<DashboardResponse> {
    const db = this.database.db;
    const memberships = await this.users.dashboardMemberships(db, user.id);
    const active = memberships.filter((m) => m.status === 'active');
    const chairedIds = [
      ...new Set(
        active
          .filter((m) => m.role === 'chair' || m.role === 'track_chair')
          .map((m) => m.conferenceId),
      ),
    ];
    const [authored, assignments, chairPapers] = await Promise.all([
      this.users.dashboardAuthorPapers(db, user.id),
      this.users.dashboardAssignments(db, user.id),
      this.users.dashboardChairPapers(db, chairedIds),
    ]);

    // Roles per conference: member roles count only while active; "author" comes from submissions,
    // "reviewer" also from having an assignment.
    const roles = new Map<string, Set<string>>();
    const addRole = (conferenceId: string, role: string) => {
      const set = roles.get(conferenceId) ?? new Set<string>();
      set.add(role);
      roles.set(conferenceId, set);
    };
    for (const m of active) addRole(m.conferenceId, m.role);
    for (const a of authored) addRole(a.conferenceId, 'author');
    for (const a of assignments) addRole(a.conferenceId, 'reviewer');

    const rows = await this.users.dashboardConferences(db, [...roles.keys()]);
    const shown = new Set(rows.map((r) => r.conferenceId));

    return {
      conferences: rows.map((c) => ({
        ...c,
        reviewDeadline: c.reviewDeadline?.toISOString() ?? null,
        submissionDeadline: c.submissionDeadline?.toISOString() ?? null,
        abstractDeadline: /^\d{4}-\d{2}-\d{2}$/.test(c.abstractDeadline ?? '')
          ? c.abstractDeadline
          : null,
        roles: [...(roles.get(c.conferenceId) ?? [])],
      })),
      authorPapers: authored.filter((p) => shown.has(p.conferenceId)),
      chairPapers: chairPapers.filter((p) => shown.has(p.conferenceId)),
      reviewerAssignments: assignments
        .filter((a) => shown.has(a.conferenceId))
        .map(({ reviewStatus, dueAt, ...a }) => ({
          ...a,
          reviewed: reviewStatus === 'submitted',
          dueAt: dueAt?.toISOString() ?? null,
        })),
      invitations: memberships
        .filter((m) => m.role === 'reviewer' || m.status === 'invited')
        .map((m) => ({
          memberId: m.memberId,
          conferenceId: m.conferenceId,
          slug: m.slug,
          acronym: m.acronym,
          title: m.title,
          country: m.country,
          role: m.role,
          status: m.status,
          maxPapers: m.maxPapers,
          invitedAt: m.invitedAt.toISOString(),
          respondedAt: m.respondedAt?.toISOString() ?? null,
          declineReason: m.declineReason,
        })),
    };
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
      hasPassword: profile.hasPassword,
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
