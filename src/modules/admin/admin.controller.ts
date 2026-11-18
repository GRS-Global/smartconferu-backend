import { Controller, Get, Query } from '@nestjs/common';
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
  AdminPaperResponse,
  AdminStatsResponse,
  AdminUserPage,
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

  @Get('users')
  @ApiOperation({ summary: 'Everyone with an account, newest first' })
  @ApiOkResponse({ type: AdminUserPage })
  users(@Query() query: UsersQuery): Promise<AdminUserPage> {
    return this.admin.users(query);
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
