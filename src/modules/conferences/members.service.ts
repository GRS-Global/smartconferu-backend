import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { normalizeEmail } from '../../core/auth/secrets.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Tx } from '../../core/database/database.types.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import { NotificationsService } from '../../core/notifications/notifications.service.js';
import { canManageTeam } from '../../core/rbac/access-rules.js';
import {
  AccessService,
  type ConferenceAccess,
} from '../../core/rbac/access.service.js';
import type { MemberRole } from '../../core/rbac/conf-roles.decorator.js';
import { ConferenceEmailsService } from './conference-emails.service.js';
import { displayName } from './conference.mapper.js';
import type {
  InvitationResponse,
  InviteMemberDto,
  MemberResponse,
  UpdateMemberDto,
} from './dto/member.dto.js';
import { type MemberRow, MembersRepository } from './members.repository.js';

type MemberWithPerson = Awaited<ReturnType<MembersRepository['list']>>[number];

function toMember(row: MemberWithPerson): MemberResponse {
  const m = row.member;
  return {
    id: m.id,
    conferenceId: m.conferenceId,
    role: m.role,
    status: m.status,
    userId: m.userId,
    name: displayName(
      row.firstName,
      row.lastName,
      m.displayName ?? row.email ?? m.invitedEmail ?? 'Invited',
    ),
    email: row.email ?? m.invitedEmail,
    affiliation: row.affiliation,
    photoPath: row.photoPath,
    expertise: m.expertise,
    maxPapers: m.maxPapers,
    invitedAt: m.invitedAt.toISOString(),
    respondedAt: m.respondedAt?.toISOString() ?? null,
    declineReason: m.declineReason,
  };
}

export interface InviteResult {
  /** False when the person was already invited or on the team in this role. */
  created: boolean;
  member: MemberResponse;
}

/**
 * The conference team. Chairs invite people by email (an account is linked now, or when they
 * sign up with that address), edit and remove them; the invited person accepts or declines.
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly members: MembersRepository,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
    private readonly emails: ConferenceEmailsService,
    private readonly audit: AuditService,
  ) {}

  async list(
    user: AuthUser,
    conferenceId: string,
    role?: MemberRole,
  ): Promise<MemberResponse[]> {
    return this.database.transaction(async (tx) => {
      await this.requireChair(tx, user, conferenceId);
      return (await this.members.list(tx, conferenceId, role)).map(toMember);
    });
  }

  /**
   * Invites someone by email. Inviting again someone who declined or was removed sends a fresh
   * invitation; someone already invited or on the team is left as they are.
   */
  async invite(
    user: AuthUser,
    conferenceId: string,
    dto: InviteMemberDto,
    client: ClientInfo,
  ): Promise<InviteResult> {
    return this.database.transaction(async (tx) => {
      const access = await this.requireChair(tx, user, conferenceId);
      if (access.status === 'rejected' || access.status === 'deleted') {
        throw AppException.businessRule(
          'This conference was declined or deleted: no one can be invited.',
        );
      }
      const role = dto.role ?? 'reviewer';
      const email = normalizeEmail(dto.email);
      const userId = await this.members.userIdByEmail(tx, email);
      const existing = await this.members.findExisting(
        tx,
        conferenceId,
        role,
        userId,
        email,
      );

      if (
        existing &&
        (existing.status === 'invited' || existing.status === 'active')
      ) {
        const unchanged = await this.members.findWithPerson(tx, existing.id);
        return { created: false, member: toMember(unchanged!) };
      }

      const fields = {
        displayName: dto.displayName ?? null,
        expertise: dto.expertise ?? [],
        maxPapers: dto.maxPapers ?? null,
        invitedBy: user.id,
        invitedAt: new Date(),
      };
      const member: MemberRow = existing
        ? await this.members.update(tx, existing.id, {
            ...fields,
            status: 'invited',
            respondedAt: null,
            declineReason: null,
          })
        : await this.members.insert(tx, {
            ...fields,
            conferenceId,
            userId,
            invitedEmail: email,
            role,
            status: 'invited',
          });

      if (member.userId) {
        await this.notifications.notify(tx, [member.userId], {
          kind: 'member_invited',
          title: `You are invited as ${role.replace('_', ' ')}`,
          body: await this.members.conferenceLabel(tx, conferenceId),
          conferenceId,
        });
      }
      if (role === 'reviewer') {
        await this.emails.reviewerInvited(
          tx,
          await this.emails.facts(tx, conferenceId),
          {
            userId: member.userId,
            email: member.invitedEmail ?? email,
            name: member.displayName,
          },
          user.id,
        );
      }
      await this.record(tx, 'member.invited', user, member, client, { role });
      const created = await this.members.findWithPerson(tx, member.id);
      return { created: true, member: toMember(created!) };
    });
  }

  async update(
    user: AuthUser,
    conferenceId: string,
    memberId: string,
    dto: UpdateMemberDto,
  ): Promise<MemberResponse> {
    return this.database.transaction(async (tx) => {
      await this.requireChair(tx, user, conferenceId);
      const member = await this.findMember(tx, conferenceId, memberId);
      const values = Object.fromEntries(
        Object.entries(dto).filter(([, value]) => value !== undefined),
      );
      if (Object.keys(values).length > 0) {
        await this.members.update(tx, member.id, values);
      }
      return toMember((await this.members.findWithPerson(tx, member.id))!);
    });
  }

  /**
   * Takes someone off the team. Their open review assignments in the conference are withdrawn;
   * reviews they already submitted stay with the papers. The last chair can't be removed.
   */
  async remove(
    user: AuthUser,
    conferenceId: string,
    memberId: string,
    client: ClientInfo,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      await this.requireChair(tx, user, conferenceId);
      const member = await this.findMember(tx, conferenceId, memberId);
      if (
        member.role === 'chair' &&
        member.status === 'active' &&
        (await this.members.countActiveChairs(tx, conferenceId)) <= 1
      ) {
        throw AppException.businessRule(
          'A conference needs at least one chair: invite another chair before removing this one.',
        );
      }
      await this.members.update(tx, member.id, { status: 'removed' });
      await this.members.deletePendingAssignments(tx, member.id);
      if (member.userId && member.role === 'reviewer') {
        await this.members.withdrawAssignments(tx, conferenceId, member.userId);
      }
      await this.record(tx, 'member.removed', user, member, client, {
        role: member.role,
      });
    });
  }

  // The invited person -----------------------------------------------------------------------

  async myInvitations(user: AuthUser): Promise<InvitationResponse[]> {
    const rows = await this.members.listForUser(this.database.db, user.id);
    return rows
      .filter(({ member }) => member.invitedBy !== member.userId)
      .map(({ member, conference }) => ({
        id: member.id,
        role: member.role,
        status: member.status,
        conference: {
          id: conference.id,
          slug: conference.slug,
          acronym: conference.acronym,
          title: conference.title,
          country: conference.country,
          startDate: conference.startDate,
          endDate: conference.endDate,
        },
        maxPapers: member.maxPapers,
        invitedAt: member.invitedAt.toISOString(),
        respondedAt: member.respondedAt?.toISOString() ?? null,
        declineReason: member.declineReason,
      }));
  }

  /**
   * Accepting makes the person an active member, and papers the chair queued for them become
   * review requests. Declining also hands back papers already given to them.
   */
  async respond(
    user: AuthUser,
    memberId: string,
    accept: boolean,
    reason: string | null | undefined,
    client: ClientInfo,
  ): Promise<InvitationResponse> {
    await this.database.transaction(async (tx) => {
      const member = await this.members.findForUpdate(tx, memberId);
      if (!member || member.userId !== user.id) {
        throw AppException.notFound('The invitation');
      }
      if (member.status !== 'invited') {
        throw AppException.businessRule(
          'This invitation has already been answered.',
        );
      }
      await this.members.update(tx, member.id, {
        status: accept ? 'active' : 'declined',
        respondedAt: new Date(),
        declineReason: accept ? null : (reason ?? null),
      });
      if (accept) {
        const papers = await this.members.activatePendingAssignments(
          tx,
          member,
          user.id,
        );
        await this.emails.invitationAccepted(
          tx,
          await this.emails.facts(tx, member.conferenceId),
          { userId: user.id, role: member.role },
          papers,
        );
      } else {
        await this.members.declineOpenAssignments(
          tx,
          member.conferenceId,
          user.id,
          reason ?? 'Declined the invitation',
        );
      }
      await this.members.deletePendingAssignments(tx, member.id);

      const name = await this.members.personName(tx, user.id);
      await this.notifications.notifyChairs(tx, member.conferenceId, {
        kind: 'invitation_answer',
        title: `${name} ${accept ? 'accepted' : 'declined'} the ${member.role.replace('_', ' ')} invitation`,
        body: accept ? null : (reason ?? null),
      });
      await this.record(
        tx,
        accept ? 'member.accepted' : 'member.declined',
        user,
        member,
        client,
        { role: member.role },
      );
    });
    const invitation = (await this.myInvitations(user)).find(
      (i) => i.id === memberId,
    );
    return invitation!;
  }

  private async requireChair(
    tx: Tx,
    user: AuthUser,
    conferenceId: string,
  ): Promise<ConferenceAccess> {
    const access = await this.access.requireConference(user, conferenceId, tx);
    if (!canManageTeam(access)) {
      throw AppException.forbidden(
        'Only a chair of this conference can manage its team.',
      );
    }
    return access;
  }

  private async findMember(
    tx: Tx,
    conferenceId: string,
    memberId: string,
  ): Promise<MemberRow> {
    const member = await this.members.findInConference(
      tx,
      conferenceId,
      memberId,
    );
    if (!member || member.status === 'removed') {
      throw AppException.notFound('The member');
    }
    return member;
  }

  private record(
    tx: Tx,
    action: string,
    user: AuthUser,
    member: MemberRow,
    client: ClientInfo,
    data: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record(
      {
        action,
        actorId: user.id,
        entityType: 'conference_member',
        entityId: member.id,
        client,
        data: { conferenceId: member.conferenceId, ...data },
      },
      tx,
    );
  }
}
