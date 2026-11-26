import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { CurrentUser } from '../../core/auth/auth.decorators.js';
import { Client, type ClientInfo } from '../../core/http/client-info.js';
import { ConferenceRef } from '../../core/http/conference-ref.pipe.js';
import { StepUp } from '../../core/rbac/step-up.guard.js';
import { SuperAdminOnly } from '../../core/rbac/super-admin.guard.js';
import { ConferenceAdminService } from './conference-admin.service.js';
import { LicenseService } from './license.service.js';
import {
  AdminCfpResponse,
  AdminConferenceResponse,
  ConferenceStatusQuery,
  AskInfoDto,
  DecisionDto,
  LicenseExpiryDto,
  SuspendDto,
  DeletionRequestResponse,
} from './dto/conference.dto.js';

const DELETION_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

class DeletionRequestQuery {
  @ApiPropertyOptional({ enum: DELETION_STATUSES })
  @IsOptional()
  @IsIn(DELETION_STATUSES)
  status?: string;
}

const CFP_STATES = [
  'draft',
  'in_review',
  'published',
  'rejected',
  'closed',
] as const;

class CfpStateQuery {
  @ApiPropertyOptional({ enum: CFP_STATES, default: 'in_review' })
  @IsOptional()
  @IsIn(CFP_STATES)
  status?: (typeof CFP_STATES)[number];
}

/** The super admin console: conference requests and deletion requests. */
@ApiTags('admin')
@ApiBearerAuth()
@SuperAdminOnly()
@Controller('admin')
export class ConferenceAdminController {
  constructor(
    private readonly admin: ConferenceAdminService,
    private readonly license: LicenseService,
  ) {}

  @Post('conferences/:conferenceId/license')
  @StepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Extend the license directly (the conference page): it runs until the date; the chairs are told',
  })
  @ApiNoContentResponse()
  extendLicense(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
    @Body() dto: LicenseExpiryDto,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.license.setExpiry(user, conferenceId, dto.expiry, client);
  }

  @Get('conferences')
  @ApiOperation({ summary: 'Every conference, with who asked for it' })
  @ApiOkResponse({ type: [AdminConferenceResponse] })
  list(
    @Query() query: ConferenceStatusQuery,
  ): Promise<AdminConferenceResponse[]> {
    return this.admin.list(query.status);
  }

  @Get('decision-emails')
  @ApiOperation({
    summary:
      'The two decision emails (approved, declined) as plain text, and the logo they carry, for the decision popup',
  })
  @ApiOkResponse({
    description: '{ approved, declined: { subject, body }, logoUrl }',
  })
  decisionEmails() {
    return this.admin.decisionEmails();
  }

  @Post('conferences/:conferenceId/decision')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Approve or decline a conference request' })
  @ApiNoContentResponse()
  decide(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
    @Body() dto: DecisionDto,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.admin.decide(
      user,
      conferenceId,
      dto.approve,
      dto.note,
      client,
      {
        subject: dto.emailSubject,
        body: dto.emailBody,
        saveAsDefault: dto.saveEmailAsDefault,
      },
    );
  }

  @Post('conferences/:conferenceId/suspend')
  @StepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Suspend: read-only for its chairs, authors and reviewers until reactivated (needs a step-up)',
  })
  @ApiNoContentResponse()
  suspend(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
    @Body() dto: SuspendDto,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.admin.setSuspended(
      user,
      conferenceId,
      true,
      dto.reason,
      client,
    );
  }

  @Post('conferences/:conferenceId/reactivate')
  @StepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Lift a suspension (needs a step-up)' })
  @ApiNoContentResponse()
  reactivate(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.admin.setSuspended(user, conferenceId, false, null, client);
  }

  @Post('conferences/:conferenceId/ask-info')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      '"Ask for info" on a conference request: the chair is notified and emailed; it stays waiting',
  })
  @ApiNoContentResponse()
  askForInfo(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
    @Body() dto: AskInfoDto,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.admin.askForInfo(user, conferenceId, dto.message, client);
  }

  @Get('cfps')
  @ApiOperation({
    summary:
      'Calls for Papers by state (default: the ones waiting for approval), with who asked for the conference',
  })
  @ApiOkResponse({ type: [AdminCfpResponse] })
  listCfps(@Query() query: CfpStateQuery): Promise<AdminCfpResponse[]> {
    return this.admin.listCfps(query.status ?? 'in_review');
  }

  @Post('conferences/:conferenceId/cfp/decision')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Approve (submissions open) or decline (with a note) a Call for Papers sent for approval',
  })
  @ApiNoContentResponse()
  decideCfp(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
    @Body() dto: DecisionDto,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.admin.decideCfp(
      user,
      conferenceId,
      dto.approve,
      dto.note,
      client,
    );
  }

  @Post('conferences/:conferenceId/undelete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Bring a deleted conference back (as archived)' })
  @ApiNoContentResponse()
  undelete(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.admin.restoreDeleted(user, conferenceId, client);
  }

  @Get('deletion-requests')
  @ApiOperation({ summary: 'Requests from chairs to delete a conference' })
  @ApiOkResponse({ type: [DeletionRequestResponse] })
  listDeletionRequests(
    @Query() query: DeletionRequestQuery,
  ): Promise<DeletionRequestResponse[]> {
    return this.admin.listDeletionRequests(query.status);
  }

  @Post('deletion-requests/:requestId/decision')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Approve (the conference is deleted) or reject a deletion request',
  })
  @ApiNoContentResponse()
  decideDeletion(
    @CurrentUser() user: AuthUser,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: DecisionDto,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.admin.decideDeletion(
      user,
      requestId,
      dto.approve,
      dto.note,
      client,
    );
  }
}
