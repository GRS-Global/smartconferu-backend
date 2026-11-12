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
import { SuperAdminOnly } from '../../core/rbac/super-admin.guard.js';
import { ConferenceAdminService } from './conference-admin.service.js';
import {
  AdminConferenceResponse,
  ConferenceStatusQuery,
  DecisionDto,
  DeletionRequestResponse,
} from './dto/conference.dto.js';

const DELETION_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

class DeletionRequestQuery {
  @ApiPropertyOptional({ enum: DELETION_STATUSES })
  @IsOptional()
  @IsIn(DELETION_STATUSES)
  status?: string;
}

/** The super admin console: conference requests and deletion requests. */
@ApiTags('admin')
@ApiBearerAuth()
@SuperAdminOnly()
@Controller('admin')
export class ConferenceAdminController {
  constructor(private readonly admin: ConferenceAdminService) {}

  @Get('conferences')
  @ApiOperation({ summary: 'Every conference, with who asked for it' })
  @ApiOkResponse({ type: [AdminConferenceResponse] })
  list(
    @Query() query: ConferenceStatusQuery,
  ): Promise<AdminConferenceResponse[]> {
    return this.admin.list(query.status);
  }

  @Post('conferences/:conferenceId/decision')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Approve or decline a conference request' })
  @ApiNoContentResponse()
  decide(
    @CurrentUser() user: AuthUser,
    @Param('conferenceId', ParseUUIDPipe) conferenceId: string,
    @Body() dto: DecisionDto,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.admin.decide(user, conferenceId, dto.approve, dto.note, client);
  }

  @Post('conferences/:conferenceId/undelete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Bring a deleted conference back (as archived)' })
  @ApiNoContentResponse()
  undelete(
    @CurrentUser() user: AuthUser,
    @Param('conferenceId', ParseUUIDPipe) conferenceId: string,
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
