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
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { CurrentUser } from '../../core/auth/auth.decorators.js';
import { Client, type ClientInfo } from '../../core/http/client-info.js';
import { SuperAdminOnly } from '../../core/rbac/super-admin.guard.js';
import {
  ApproveProfileRequestDto,
  ProfileRequestResponse,
  ProfileRequestsQuery,
  RejectProfileRequestDto,
} from './dto/profile-requests.dto.js';
import { ProfileRequestsService } from './profile-requests.service.js';

/** Super Admin › Profile Verification: new institutions and societies members typed. */
@ApiTags('admin')
@ApiBearerAuth()
@SuperAdminOnly()
@Controller('admin/profile-requests')
export class ProfileRequestsController {
  constructor(private readonly requests: ProfileRequestsService) {}

  @Get()
  @ApiOperation({
    summary: 'Names members typed that are not on the lists yet',
  })
  @ApiOkResponse({ type: [ProfileRequestResponse] })
  list(
    @Query() query: ProfileRequestsQuery,
  ): Promise<ProfileRequestResponse[]> {
    return this.requests.list(query.status ?? 'pending', query.kind);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Add the name to the master data (or link it to an existing entry); the members who typed it are updated and notified',
  })
  @ApiNoContentResponse()
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveProfileRequestDto,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.requests.approve(user, id, dto, client);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Reject the name with a reason the members see' })
  @ApiNoContentResponse()
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectProfileRequestDto,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.requests.reject(user, id, dto, client);
  }
}
