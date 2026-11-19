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
import { ConferenceRef } from '../../core/http/conference-ref.pipe.js';
import { SuperAdminOnly } from '../../core/rbac/super-admin.guard.js';
import {
  AdminLicenseRequestResponse,
  DecideLicenseDto,
  LicenseRequestResponse,
  LicenseStatusQuery,
  RequestLicenseDto,
} from './dto/license.dto.js';
import { LicenseService } from './license.service.js';

/** A chair's requests to move the conference's license date. */
@ApiTags('conferences')
@ApiBearerAuth()
@Controller('conferences/:conferenceId/license-request')
export class ConferenceLicenseController {
  constructor(private readonly license: LicenseService) {}

  @Get()
  @ApiOperation({
    summary:
      "The conference's latest license extension request, or null (chairs)",
  })
  @ApiOkResponse({ type: LicenseRequestResponse })
  async latest(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
  ): Promise<LicenseRequestResponse | Record<string, never>> {
    // `null` would send an empty body; an empty object means "none".
    return (await this.license.latest(user, conferenceId)) ?? {};
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Ask a Super Admin to move the license date (chairs); one request can wait at a time',
  })
  @ApiOkResponse({ type: LicenseRequestResponse })
  request(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
    @Body() dto: RequestLicenseDto,
    @Client() client: ClientInfo,
  ): Promise<LicenseRequestResponse> {
    return this.license.request(user, conferenceId, dto, client);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Take back the request that is waiting (chairs)' })
  @ApiNoContentResponse()
  withdraw(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.license.withdraw(user, conferenceId, client);
  }
}

/** Super Admin › License Extensions. */
@ApiTags('admin')
@ApiBearerAuth()
@SuperAdminOnly()
@Controller('admin/license-requests')
export class AdminLicenseController {
  constructor(private readonly license: LicenseService) {}

  @Get()
  @ApiOperation({
    summary: 'License extension requests by state (default: the ones waiting)',
  })
  @ApiOkResponse({ type: [AdminLicenseRequestResponse] })
  list(
    @Query() query: LicenseStatusQuery,
  ): Promise<AdminLicenseRequestResponse[]> {
    return this.license.list(query.status ?? 'pending');
  }

  @Post(':requestId/decision')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Approve (the license runs until newExpiry, default the date asked for) or decline (with a reason)',
  })
  @ApiNoContentResponse()
  decide(
    @CurrentUser() user: AuthUser,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: DecideLicenseDto,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.license.decide(
      user,
      requestId,
      dto.approve,
      dto.newExpiry,
      dto.reason,
      client,
    );
  }
}
