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
  MyVerificationResponse,
  RejectVerificationDto,
  RequestVerificationDto,
  VerificationResponse,
  VerificationsQuery,
} from './dto/profile-verification.dto.js';
import { ProfileVerificationService } from './profile-verification.service.js';

/** My Profile › "Verify my profile". */
@ApiTags('users')
@ApiBearerAuth()
@Controller('me/profile-verification')
export class MyProfileVerificationController {
  constructor(private readonly verification: ProfileVerificationService) {}

  @Get()
  @ApiOperation({ summary: 'Where my profile verification stands' })
  @ApiOkResponse({ type: MyVerificationResponse })
  mine(@CurrentUser() user: AuthUser): Promise<MyVerificationResponse> {
    return this.verification.mine(user);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ask the Super Admin to verify my profile' })
  @ApiOkResponse({ type: MyVerificationResponse })
  request(
    @CurrentUser() user: AuthUser,
    @Body() dto: RequestVerificationDto,
    @Client() client: ClientInfo,
  ): Promise<MyVerificationResponse> {
    return this.verification.request(user, dto, client);
  }

  @Delete()
  @ApiOperation({ summary: 'Withdraw my waiting verification request' })
  @ApiOkResponse({ type: MyVerificationResponse })
  withdraw(@CurrentUser() user: AuthUser): Promise<MyVerificationResponse> {
    return this.verification.withdraw(user);
  }
}

/** Super Admin › Profile Verification. */
@ApiTags('admin')
@ApiBearerAuth()
@SuperAdminOnly()
@Controller('admin/profile-verifications')
export class AdminProfileVerificationController {
  constructor(private readonly verification: ProfileVerificationService) {}

  @Get()
  @ApiOperation({ summary: 'Profile verification requests' })
  @ApiOkResponse({ type: [VerificationResponse] })
  list(@Query() query: VerificationsQuery): Promise<VerificationResponse[]> {
    return this.verification.list(query.status ?? 'pending');
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Verify the profile (green tick) and email the member',
  })
  @ApiNoContentResponse()
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.verification.approve(user, id, client);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Reject with a reason; the member is emailed' })
  @ApiNoContentResponse()
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectVerificationDto,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.verification.reject(user, id, dto, client);
  }
}
