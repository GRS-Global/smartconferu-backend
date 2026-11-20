import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { CurrentUser } from '../../core/auth/auth.decorators.js';
import { Client, type ClientInfo } from '../../core/http/client-info.js';
import { SuperAdminOnly } from '../../core/rbac/super-admin.guard.js';
import { AuthService } from './auth.service.js';
import { MfaCodeDto } from './dto/auth.dto.js';

class StepUpCodeResponse {
  @ApiProperty({
    enum: ['totp', 'email'],
    description:
      'totp: type a code from the authenticator app. email: a code was just emailed.',
  })
  factor: 'totp' | 'email';

  @ApiPropertyOptional({
    description:
      'Development only (DEV_SHOW_EMAIL_CODES): the emailed code. Never sent in production.',
  })
  devCode?: string;
}

/**
 * "Confirm it's you" for high-risk admin actions: a fresh second-factor code makes this session
 * able to do them for 10 minutes (StepUpGuard).
 */
@ApiTags('auth')
@ApiBearerAuth()
@SuperAdminOnly()
@Controller('auth/step-up')
export class StepUpController {
  constructor(private readonly auth: AuthService) {}

  @Post('code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Start a step-up: emails a code (or says to use the authenticator app)',
  })
  @ApiOkResponse({ type: StepUpCodeResponse })
  code(@CurrentUser() user: AuthUser): Promise<StepUpCodeResponse> {
    return this.auth.requestStepUpCode(user);
  }

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Finish a step-up with the code: high-risk admin actions are allowed for 10 minutes',
  })
  @ApiNoContentResponse()
  verify(
    @CurrentUser() user: AuthUser,
    @Body() dto: MfaCodeDto,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.auth.verifyStepUp(user, dto.code, client);
  }
}
