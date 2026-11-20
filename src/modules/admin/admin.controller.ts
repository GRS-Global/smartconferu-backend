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
import type { AuthUser } from '../../core/auth/auth-user.js';
import { CurrentUser } from '../../core/auth/auth.decorators.js';
import { Client, type ClientInfo } from '../../core/http/client-info.js';
import { ConferenceRef } from '../../core/http/conference-ref.pipe.js';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { SuperAdminOnly } from '../../core/rbac/super-admin.guard.js';
import { AdminService } from './admin.service.js';
import {
  ActivityPage,
  ActivityQuery,
  MonthlyActivityResponse,
  YearQuery,
  AdminPaperResponse,
  AdminStatsResponse,
  AdminUserDetailResponse,
  AdminUserPage,
  AdminUserResponse,
  SetUserStatusDto,
  UsersQuery,
} from './dto/admin.dto.js';

class AdminAccessResponse {
  @ApiProperty({ example: true })
  superAdmin: true;
}

/** The super-admin console. Every route here needs a super admin in a two-step-verified session. */
@ApiTags('admin')
@ApiBearerAuth()
@SuperAdminOnly()
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('access')
  @ApiOperation({
    summary:
      'Check admin access; 403 AUTH_MFA_SETUP_REQUIRED / AUTH_MFA_REQUIRED say what is missing',
  })
  @ApiOkResponse({ type: AdminAccessResponse })
  access(): AdminAccessResponse {
    return { superAdmin: true };
  }

  @Get('stats')
  @ApiOperation({ summary: 'Platform numbers for the dashboard' })
  @ApiOkResponse({ type: AdminStatsResponse })
  stats(): Promise<AdminStatsResponse> {
    return this.admin.stats();
  }

  @Get('stats/activity')
  @ApiOperation({
    summary:
      'Papers submitted and reviews sent per month of a year (the dashboard chart)',
  })
  @ApiOkResponse({ type: MonthlyActivityResponse })
  monthlyActivity(@Query() query: YearQuery): Promise<MonthlyActivityResponse> {
    return this.admin.monthlyActivity(
      query.year ?? new Date().getUTCFullYear(),
    );
  }

  @Get('users')
  @ApiOperation({ summary: 'Everyone with an account, newest first' })
  @ApiOkResponse({ type: AdminUserPage })
  users(@Query() query: UsersQuery): Promise<AdminUserPage> {
    return this.admin.users(query);
  }

  @Get('users/:userId')
  @ApiOperation({
    summary: 'One account: roles, conferences and recent activity',
  })
  @ApiOkResponse({ type: AdminUserDetailResponse })
  user(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<AdminUserDetailResponse> {
    return this.admin.user(userId);
  }

  @Post('users/:userId/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Suspend an account: every session ends and signing in is refused (not your own, not a super admin)',
  })
  @ApiOkResponse({ type: AdminUserResponse })
  suspend(
    @CurrentUser() admin: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetUserStatusDto,
    @Client() client: ClientInfo,
  ): Promise<AdminUserResponse> {
    return this.admin.setUserStatus(
      admin,
      userId,
      'disabled',
      dto.reason,
      client,
    );
  }

  @Post('users/:userId/reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Let a suspended account sign in again' })
  @ApiOkResponse({ type: AdminUserResponse })
  reactivate(
    @CurrentUser() admin: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetUserStatusDto,
    @Client() client: ClientInfo,
  ): Promise<AdminUserResponse> {
    return this.admin.setUserStatus(
      admin,
      userId,
      'active',
      dto.reason,
      client,
    );
  }

  @Get('activity')
  @ApiOperation({ summary: 'What happened on the platform, newest first' })
  @ApiOkResponse({ type: ActivityPage })
  activity(@Query() query: ActivityQuery): Promise<ActivityPage> {
    return this.admin.activity(query);
  }

  @Get('conferences/:conferenceId/papers')
  @ApiOperation({
    summary: "A conference's papers with their review stage and reviewers",
  })
  @ApiOkResponse({ type: [AdminPaperResponse] })
  papers(@ConferenceRef() conferenceId: string): Promise<AdminPaperResponse[]> {
    return this.admin.conferencePapers(conferenceId);
  }
}
