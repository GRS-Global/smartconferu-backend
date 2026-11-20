import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
import { StepUp } from '../../core/rbac/step-up.guard.js';
import { SuperAdminOnly } from '../../core/rbac/super-admin.guard.js';
import { AdminUsersService } from './admin-users.service.js';
import {
  AdminSessionResponse,
  MergeUsersDto,
  ViewAsDto,
  ViewAsResponse,
} from './dto/admin.dto.js';

/** Support actions on one account (its page in the console). */
@ApiTags('admin')
@ApiBearerAuth()
@SuperAdminOnly()
@Controller('admin/users/:userId')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get('sessions')
  @ApiOperation({ summary: 'Where the user is signed in' })
  @ApiOkResponse({ type: [AdminSessionResponse] })
  sessions(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<AdminSessionResponse[]> {
    return this.users.sessions(userId);
  }

  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign the user out of one device' })
  @ApiNoContentResponse()
  revokeSession(
    @CurrentUser() admin: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.users.revokeSession(admin, userId, sessionId, client);
  }

  @Post('view-as')
  @StepUp()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '"View as": a read-only, 30-minute token for the user app as this person, with a reason (needs a step-up)',
  })
  @ApiOkResponse({ type: ViewAsResponse })
  viewAs(
    @CurrentUser() admin: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ViewAsDto,
    @Client() client: ClientInfo,
  ): Promise<ViewAsResponse> {
    return this.users.viewAs(admin, userId, dto.reason.trim(), client);
  }

  @Post('reset-mfa')
  @StepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      '"Reset 2-step": the authenticator app is removed; the user sets it up again (needs a step-up)',
  })
  @ApiNoContentResponse()
  resetMfa(
    @CurrentUser() admin: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.users.resetMfa(admin, userId, client);
  }

  @Post('merge')
  @StepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      '"Merge accounts": everything of the other account moves here; it is closed (needs a step-up)',
  })
  @ApiNoContentResponse()
  merge(
    @CurrentUser() admin: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: MergeUsersDto,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.users.merge(admin, userId, dto.otherUserId, client);
  }
}
