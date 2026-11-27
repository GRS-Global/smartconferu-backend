import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiExtraModels,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { CurrentUser, Public } from '../../core/auth/auth.decorators.js';
import { Client, type ClientInfo } from '../../core/http/client-info.js';
import {
  AuthCookies,
  MFA_COOKIE,
  REFRESH_COOKIE,
  TRUSTED_DEVICE_COOKIE,
} from './auth-cookies.js';
import {
  AuthService,
  type SignInOutcome,
  type SignInResult,
} from './auth.service.js';
import {
  ChangePasswordDto,
  EmailDto,
  MessageResponse,
  MfaCodeDto,
  MfaRequiredResponse,
  DevCodeResponse,
  RegisterDto,
  ResetPasswordDto,
  SessionResponse,
  PasswordSignInDto,
  SignInDto,
  SignInWithCodeDto,
  TokenDto,
} from './dto/auth.dto.js';

const CHECK_EMAIL: MessageResponse = {
  message:
    'If an account exists for that address, we have sent an email to it.',
};

/** Sign-in endpoints answer with a session, or ask for the second step. */
const SIGN_IN_RESPONSE = {
  description:
    'Signed in (access token + refresh cookie), or `mfaRequired`: send a code to POST /auth/mfa/verify.',
  schema: {
    oneOf: [
      { $ref: getSchemaPath(SessionResponse) },
      { $ref: getSchemaPath(MfaRequiredResponse) },
    ],
  },
};

/**
 * Refresh and sign-out run on every page load of the web app, so they get the app-wide limit
 * (RATE_LIMIT_PER_MINUTE) instead of the strict one below: otherwise a few reloads in a minute, or
 * many people behind one university / office IP, sign people out.
 */
const SESSION_LIMIT = {
  default: {
    limit: () => Number(process.env.RATE_LIMIT_PER_MINUTE) || 300,
    ttl: 60_000,
  },
};

@ApiTags('auth')
@ApiExtraModels(SessionResponse, MfaRequiredResponse)
@Controller('auth')
// Tighter than the global limit: these endpoints are what password-guessing scripts hit.
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cookies: AuthCookies,
  ) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Create an account; a confirmation link is emailed',
  })
  @ApiAcceptedResponse({ type: MessageResponse })
  async register(
    @Body() dto: RegisterDto,
    @Client() client: ClientInfo,
  ): Promise<MessageResponse> {
    await this.auth.register(dto, client);
    return { message: 'Check your email to confirm your address.' };
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Confirm an email address from the emailed link; signs the user in',
  })
  @ApiOkResponse(SIGN_IN_RESPONSE)
  async verifyEmail(
    @Body() dto: TokenDto,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse | MfaRequiredResponse> {
    return this.respond(res, await this.auth.verifyEmail(dto.token, client));
  }

  @Public()
  @Post('verify-email/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Send a new confirmation link' })
  @ApiAcceptedResponse({ type: MessageResponse })
  async resendVerification(@Body() dto: EmailDto): Promise<MessageResponse> {
    await this.auth.resendVerification(dto.email);
    return CHECK_EMAIL;
  }

  @Public()
  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with email and password' })
  @ApiOkResponse(SIGN_IN_RESPONSE)
  async signIn(
    @Body() dto: PasswordSignInDto,
    @Req() req: Request,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse | MfaRequiredResponse> {
    return this.respond(
      res,
      await this.auth.signInWithPassword(dto.email, dto.password, client, {
        remember: dto.remember,
        trustedDeviceToken: this.cookies.read(req, TRUSTED_DEVICE_COOKIE),
      }),
    );
  }

  @Public()
  @Post('sign-in/code')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Email a 6-digit sign-in code' })
  @ApiAcceptedResponse({ type: MessageResponse })
  async requestCode(@Body() dto: EmailDto): Promise<MessageResponse> {
    await this.auth.requestLoginCode(dto.email);
    return CHECK_EMAIL;
  }

  @Public()
  @Post('sign-in/code/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with an emailed code' })
  @ApiOkResponse(SIGN_IN_RESPONSE)
  async signInWithCode(
    @Body() dto: SignInWithCodeDto,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse | MfaRequiredResponse> {
    return this.respond(
      res,
      await this.auth.signInWithCode(dto.email, dto.code, client),
    );
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth(MFA_COOKIE)
  @ApiOperation({
    summary:
      'Second step of a sign-in: a code from the authenticator app, a recovery code, or the emailed code',
  })
  @ApiOkResponse({ type: SessionResponse })
  async verifyMfa(
    @Body() dto: MfaCodeDto,
    @Req() req: Request,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    this.cookies.assertAllowedOrigin(req);
    const session = await this.auth.completeMfaChallenge(
      this.cookies.read(req, MFA_COOKIE),
      dto.code,
      client,
      dto.trustDevice ?? false,
    );
    this.cookies.clear(res, MFA_COOKIE);
    if (session.trustedDevice) {
      this.cookies.setTrustedDevice(
        res,
        session.trustedDevice.token,
        session.trustedDevice.expiresAt,
      );
    }
    return this.withSession(res, session);
  }

  @Public()
  @Post('trusted-device/forget')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth(TRUSTED_DEVICE_COOKIE)
  @ApiOperation({
    summary:
      '"Forget this device": the emailed admin code is asked again at the next sign-in',
  })
  @ApiNoContentResponse()
  async forgetTrustedDevice(
    @Req() req: Request,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    this.cookies.assertAllowedOrigin(req);
    await this.auth.forgetTrustedDevice(
      this.cookies.read(req, TRUSTED_DEVICE_COOKIE),
      client,
    );
    this.cookies.clear(res, TRUSTED_DEVICE_COOKIE);
  }

  @Public()
  @Post('mfa/email-code')
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth(MFA_COOKIE)
  @ApiOperation({
    summary:
      'Email a new code for a pending sign-in whose second step is an emailed code (factor: email)',
  })
  @ApiOkResponse({ type: DevCodeResponse })
  async resendMfaEmailCode(@Req() req: Request): Promise<DevCodeResponse> {
    this.cookies.assertAllowedOrigin(req);
    return this.auth.resendMfaEmailCode(this.cookies.read(req, MFA_COOKIE));
  }

  @Public()
  @Post('refresh')
  @Throttle(SESSION_LIMIT)
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth(REFRESH_COOKIE)
  @ApiOperation({ summary: 'Get a new access token using the refresh cookie' })
  @ApiOkResponse({ type: SessionResponse })
  async refresh(
    @Req() req: Request,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    this.cookies.assertAllowedOrigin(req);
    try {
      return this.withSession(
        res,
        await this.auth.refresh(this.cookies.read(req, REFRESH_COOKIE), client),
      );
    } catch (error) {
      this.cookies.clear(res, REFRESH_COOKIE);
      throw error;
    }
  }

  @Public()
  @Post('sign-out')
  @Throttle(SESSION_LIMIT)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth(REFRESH_COOKIE)
  @ApiOperation({ summary: 'End this session' })
  @ApiNoContentResponse()
  async signOut(
    @Req() req: Request,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    this.cookies.assertAllowedOrigin(req);
    await this.auth.signOut(this.cookies.read(req, REFRESH_COOKIE), client);
    this.cookies.clear(res, REFRESH_COOKIE);
  }

  @Post('sign-out/everywhere')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'End every session of the signed-in user, on all devices',
  })
  @ApiNoContentResponse()
  async signOutEverywhere(
    @CurrentUser() user: AuthUser,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.signOutEverywhere(user, client);
    this.cookies.clear(res, REFRESH_COOKIE);
  }

  @Public()
  @Post('password/forgot')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Email a password reset link' })
  @ApiAcceptedResponse({ type: MessageResponse })
  async forgotPassword(@Body() dto: EmailDto): Promise<MessageResponse> {
    await this.auth.forgotPassword(dto.email);
    return CHECK_EMAIL;
  }

  @Public()
  @Post('admin/password/forgot')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Super Admin console: email a reset link that opens the console (super admins only; same answer for any address)',
  })
  @ApiAcceptedResponse({ type: MessageResponse })
  async forgotAdminPassword(@Body() dto: EmailDto): Promise<MessageResponse> {
    await this.auth.forgotAdminPassword(dto.email);
    return CHECK_EMAIL;
  }

  @Public()
  @Post('password/reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Set a new password from the emailed link; signs out every session',
  })
  @ApiNoContentResponse()
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Client() client: ClientInfo,
  ): Promise<void> {
    await this.auth.resetPassword(dto.token, dto.password, client);
  }

  @Post('password/change')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change the password; other devices are signed out',
  })
  @ApiNoContentResponse()
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
    @Client() client: ClientInfo,
  ): Promise<void> {
    await this.auth.changePassword(
      user,
      dto.currentPassword,
      dto.newPassword,
      client,
    );
  }

  private respond(
    res: Response,
    outcome: SignInOutcome,
  ): SessionResponse | MfaRequiredResponse {
    if (outcome.kind === 'mfa_required') {
      this.cookies.setMfaChallenge(res, outcome.challenge);
      return {
        mfaRequired: true,
        factor: outcome.factor,
        message:
          outcome.factor === 'email'
            ? 'We emailed you a 6-digit code. Enter it to finish signing in.'
            : 'Enter the code from your authenticator app.',
        ...(outcome.devCode ? { devCode: outcome.devCode } : {}),
      };
    }
    return this.withSession(res, outcome.session);
  }

  private withSession(res: Response, session: SignInResult): SessionResponse {
    this.cookies.setRefresh(
      res,
      session.refreshToken,
      session.refreshExpiresAt,
      session.refreshPersistent,
    );
    return {
      accessToken: session.accessToken,
      tokenType: 'Bearer',
      expiresIn: session.expiresIn,
      user: session.user,
    };
  }
}
