import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Tx } from '../../core/database/database.types.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import { canEditCfp, canViewTeam } from '../../core/rbac/access-rules.js';
import {
  AccessService,
  type ConferenceAccess,
} from '../../core/rbac/access.service.js';
import {
  type CfpRow,
  ConferencesRepository,
} from './conferences.repository.js';
import type { CfpResponse, UpdateCfpDto } from './dto/cfp.dto.js';

function toCfp(row: CfpRow): CfpResponse {
  return {
    conferenceId: row.conferenceId,
    status: row.status,
    content: row.content as Record<string, unknown>,
    theme: row.theme as Record<string, unknown>,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The Call for Papers of a conference. Chairs and CFP managers edit it and publish it once the
 * conference is approved; papers can be submitted only while it is published.
 */
@Injectable()
export class CfpsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly conferences: ConferencesRepository,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  /** The team sees the CFP in any state. */
  async get(user: AuthUser, conferenceId: string): Promise<CfpResponse> {
    return this.database.transaction(async (tx) => {
      const access = await this.access.requireConference(
        user,
        conferenceId,
        tx,
      );
      if (!canViewTeam(access) && !access.isCreator) {
        throw AppException.forbidden(
          'Only the conference team can open its Call for Papers editor.',
        );
      }
      return toCfp(await this.conferences.findCfp(tx, conferenceId));
    });
  }

  async update(
    user: AuthUser,
    conferenceId: string,
    dto: UpdateCfpDto,
  ): Promise<CfpResponse> {
    return this.database.transaction(async (tx) => {
      const access = await this.requireEditor(tx, user, conferenceId);
      if (access.status === 'rejected' || access.status === 'deleted') {
        throw AppException.businessRule(
          'This conference was declined or deleted and can no longer be changed.',
        );
      }
      const values: Partial<CfpRow> = {};
      if (dto.content !== undefined) values.content = dto.content;
      if (dto.theme !== undefined) values.theme = dto.theme;
      if (Object.keys(values).length === 0) {
        return toCfp(await this.conferences.findCfp(tx, conferenceId));
      }
      return toCfp(await this.conferences.updateCfp(tx, conferenceId, values));
    });
  }

  /** From now on the submission link works. Needs an approved (active) conference. */
  async publish(
    user: AuthUser,
    conferenceId: string,
    client: ClientInfo,
  ): Promise<CfpResponse> {
    return this.database.transaction(async (tx) => {
      const access = await this.requireEditor(tx, user, conferenceId);
      if (access.status !== 'active') {
        throw AppException.businessRule(
          'The conference has to be approved (and not archived) before its Call for Papers can be published.',
        );
      }
      const current = await this.conferences.findCfp(tx, conferenceId);
      if (current.status === 'published') {
        return toCfp(current);
      }
      const now = new Date();
      const row = await this.conferences.updateCfp(tx, conferenceId, {
        status: 'published',
        submittedAt: current.submittedAt ?? now,
        decidedAt: now,
      });
      await this.record(tx, 'cfp.published', user, conferenceId, client);
      return toCfp(row);
    });
  }

  /** New papers stop at once; papers already sent are untouched. */
  async close(
    user: AuthUser,
    conferenceId: string,
    client: ClientInfo,
  ): Promise<CfpResponse> {
    return this.database.transaction(async (tx) => {
      await this.requireEditor(tx, user, conferenceId);
      const current = await this.conferences.findCfp(tx, conferenceId);
      if (current.status !== 'published') {
        throw AppException.businessRule(
          'Only a published Call for Papers can be closed.',
        );
      }
      const row = await this.conferences.updateCfp(tx, conferenceId, {
        status: 'closed',
        decidedAt: new Date(),
      });
      await this.record(tx, 'cfp.closed', user, conferenceId, client);
      return toCfp(row);
    });
  }

  private async requireEditor(
    tx: Tx,
    user: AuthUser,
    conferenceId: string,
  ): Promise<ConferenceAccess> {
    const access = await this.access.requireConference(user, conferenceId, tx);
    if (!canEditCfp(access)) {
      throw AppException.forbidden(
        'Only a chair or CFP manager of this conference can do this.',
      );
    }
    return access;
  }

  private record(
    tx: Tx,
    action: string,
    user: AuthUser,
    conferenceId: string,
    client: ClientInfo,
  ): Promise<void> {
    return this.audit.record(
      {
        action,
        actorId: user.id,
        entityType: 'conference',
        entityId: conferenceId,
        client,
      },
      tx,
    );
  }
}
