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
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { CurrentUser, Public } from '../../core/auth/auth.decorators.js';
import { Client, type ClientInfo } from '../../core/http/client-info.js';
import { AccountDeletionService } from './account-deletion.service.js';
import { AccountService } from './account.service.js';
import { AuthCookies, MFA_COOKIE, REFRESH_COOKIE } from './auth-cookies.js';
import {
  ChangeEmailDto,
  DeleteAccountDto,
  EmailDto,
  MessageResponse,
  MfaCodeDto,
  MfaRequiredResponse,
  SessionResponse,
  SignInWithCodeDto,
  TokenDto,
} from './dto/auth.dto.js';

class SessionInfoResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ description: 'This is the session making the request.' })
  current: boolean;
  @ApiProperty({ format: 'date-time' }) signedInAt: string;
  @ApiProperty({ format: 'date-time' }) lastActiveAt: string;
  @ApiProperty({ format: 'date-time' }) expiresAt: string;
  @ApiProperty({ nullable: true, type: String }) userAgent: string | null;
  @ApiProperty({ nullable: true, type: String }) ipAddress: string | null;
  @ApiProperty() mfaVerified: boolean;
}

class MfaStatusResponse {
  @ApiProperty() enabled: boolean;
  @ApiProperty() recoveryCodesLeft: number;
  @ApiProperty({
    description: 'Super admins must turn it on to use admin features.',
  })
  required: boolean;
}

class TotpSetupResponse {
  @ApiProperty({ description: 'For typing into the app by hand.' })
  secret: string;
  @ApiProperty({ description: 'Show as a QR code.' }) otpauthUrl: string;
}

class MfaEnabledResponse {
  @ApiProperty({
    type: [String],
    description: 'Shown once. Each works one time.',
  })
  recoveryCodes: string[];
  @ApiProperty({
    description: 'A new access token for this session, now marked as verified.',
  })
  accessToken: string;
}

class RecoveryCodesResponse {
  @ApiProperty({ type: [String] }) recoveryCodes: string[];
}

@ApiTags('account')
@Controller('auth')
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class AccountController {
  constructor(
    private readonly account: AccountService,
    private readonly deletion: AccountDeletionService,
    private readonly cookies: AuthCookies,
  ) {}

  // Delete the account ------------------------------------------------------------------------

  @Post('account/delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Delete my own account for good (body: { confirm: 'DELETE' }). 409 with details.blockers when it still owns records that belong to conferences (created a conference, chairs one, submitted a paper, wrote a review).",
  })
  @ApiNoContentResponse()
  async deleteAccount(
    @CurrentUser() user: AuthUser,
    @Body() dto: DeleteAccountDto,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.deletion.delete(user, dto.confirm, client);
    this.cookies.clear(res, REFRESH_COOKIE);
  }

  // Email address ------------------------------------------------------------------------------

  @Post('email/change')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Change the email address; a confirmation link goes to the new one',
  })
  @ApiAcceptedResponse({ type: MessageResponse })
  async changeEmail(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangeEmailDto,
    @Client() client: ClientInfo,
  ): Promise<MessageResponse> {
    await this.account.requestEmailChange(
      user,
      dto.newEmail,
      dto.currentPassword,
      client,
    );
    return { message: 'Check the new address for a confirmation link.' };
  }

  @Public()
  @Post('email/change/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Confirm the new address from the emailed link' })
  @ApiNoContentResponse()
  async confirmEmail(
    @Body() dto: TokenDto,
    @Client() client: ClientInfo,
  ): Promise<void> {
    await this.account.confirmEmailChange(dto.token, client);
  }

  // Sessions -----------------------------------------------------------------------------------

  @Get('sessions')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Devices where the user is signed in' })
  @ApiOkResponse({ type: [SessionInfoResponse] })
  async sessions(
    @CurrentUser() user: AuthUser,
  ): Promise<SessionInfoResponse[]> {
    return (await this.account.listSessions(user)).map((session) => ({
      ...session,
      current: session.id === user.sessionId,
      signedInAt: session.signedInAt.toISOString(),
      lastActiveAt: session.lastActiveAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
    }));
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sign out one device' })
  @ApiNoContentResponse()
  async revokeSession(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.account.revokeSession(user, id, client);
    if (id === user.sessionId) {
      this.cookies.clear(res, REFRESH_COOKIE);
    }
  }

  // Two-step verification ----------------------------------------------------------------------

  @Get('mfa')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Two-step verification status' })
  @ApiOkResponse({ type: MfaStatusResponse })
  mfaStatus(@CurrentUser() user: AuthUser): Promise<MfaStatusResponse> {
    return this.account.mfaStatus(user);
  }

  @Post('mfa/totp/setup')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Start setting up an authenticator app (stays off until confirmed)',
  })
  @ApiOkResponse({ type: TotpSetupResponse })
  setupTotp(@CurrentUser() user: AuthUser): Promise<TotpSetupResponse> {
    return this.account.beginMfaSetup(user);
  }

  @Post('mfa/totp/enable')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Confirm with a first code; turns two-step verification on and signs out other devices',
  })
  @ApiOkResponse({ type: MfaEnabledResponse })
  enableTotp(
    @CurrentUser() user: AuthUser,
    @Body() dto: MfaCodeDto,
    @Client() client: ClientInfo,
  ): Promise<MfaEnabledResponse> {
    return this.account.enableMfa(user, dto.code, client);
  }

  @Post('mfa/totp/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Turn two-step verification off (needs a current code)',
  })
  @ApiNoContentResponse()
  async disableTotp(
    @CurrentUser() user: AuthUser,
    @Body() dto: MfaCodeDto,
    @Client() client: ClientInfo,
  ): Promise<void> {
    await this.account.disableMfa(user, dto.code, client);
  }

  @Post('mfa/recovery-codes')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Replace the recovery codes (needs a current code)',
  })
  @ApiOkResponse({ type: RecoveryCodesResponse })
  async recoveryCodes(
    @CurrentUser() user: AuthUser,
    @Body() dto: MfaCodeDto,
    @Client() client: ClientInfo,
  ): Promise<RecoveryCodesResponse> {
    return {
      recoveryCodes: await this.account.regenerateRecoveryCodes(
        user,
        dto.code,
        client,
      ),
    };
  }

  // Merge --------------------------------------------------------------------------------------

  @Post('account/merge')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'New ORCID sign-in without an email: email a code to the account that owns an address',
  })
  @ApiAcceptedResponse({ type: MessageResponse })
  async requestMerge(
    @CurrentUser() user: AuthUser,
    @Body() dto: EmailDto,
  ): Promise<MessageResponse> {
    await this.account.requestMerge(user, dto.email);
    return {
      message:
        'If an account exists for that address, we have sent a code to it.',
    };
  }

  @Post('account/merge/verify')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Confirm the code: this sign-in moves to that account, which is signed in',
  })
  @ApiOkResponse({ type: SessionResponse })
  async completeMerge(
    @CurrentUser() user: AuthUser,
    @Body() dto: SignInWithCodeDto,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse | MfaRequiredResponse> {
    const outcome = await this.account.completeMerge(
      user,
      dto.email,
      dto.code,
      client,
    );
    if (outcome.kind === 'mfa_required') {
      this.cookies.setMfaChallenge(res, outcome.challenge);
      return {
        mfaRequired: true,
        message: 'Enter the code from your authenticator app.',
      };
    }
    const { session } = outcome;
    this.cookies.clear(res, MFA_COOKIE);
    this.cookies.setRefresh(
      res,
      session.refreshToken,
      session.refreshExpiresAt,
    );
    return {
      accessToken: session.accessToken,
      tokenType: 'Bearer',
      expiresIn: session.expiresIn,
      user: session.user,
    };
  }
}
