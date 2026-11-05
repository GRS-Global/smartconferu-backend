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
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiFoundResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiQuery,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import type { Env } from '../../../config/env.js';
import type { AuthUser } from '../../../core/auth/auth-user.js';
import { CurrentUser, Public } from '../../../core/auth/auth.decorators.js';
import { Client, type ClientInfo } from '../../../core/http/client-info.js';
import {
  AuthCookies,
  MFA_COOKIE,
  OAUTH_STATE_COOKIE,
} from '../auth-cookies.js';
import { OAuthService } from './oauth.service.js';
import type { ProviderId } from './providers.js';

class ProvidersResponse {
  @ApiProperty({ enum: ['google', 'microsoft', 'orcid'], isArray: true })
  providers: ProviderId[];
}

class LinkProviderDto {
  @ApiPropertyOptional({
    example: '/settings/account',
    description: 'Where to land in the app afterwards.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  returnTo?: string;
}

class LinkProviderResponse {
  @ApiProperty({
    description: "Send the browser here (the provider's sign-in page).",
  })
  url: string;
}

class IdentityResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: ['google', 'microsoft', 'orcid'] }) provider: ProviderId;
  @ApiProperty({ nullable: true, type: String }) email: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  lastUsedAt: string | null;
}

/**
 * Browser flow: the app links to `/auth/oauth/:provider/start`; the provider sends the user back
 * to `/callback`, which sets the session cookie and redirects to `<APP_URL>/auth/callback` with
 * `status=signed_in | mfa_required | linked` or `error=<code>`, plus `next=<path>`. The app then
 * calls `POST /auth/refresh` (or `POST /auth/mfa/verify`) to get its access token.
 */
@ApiTags('auth')
@Controller('auth')
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class OAuthController {
  private readonly appUrl: string;

  constructor(
    private readonly oauth: OAuthService,
    private readonly cookies: AuthCookies,
    config: ConfigService<Env, true>,
  ) {
    this.appUrl = config.get('APP_URL', { infer: true }).replace(/\/+$/, '');
  }

  @Public()
  @Get('providers')
  @ApiOperation({ summary: 'Sign-in providers available on this server' })
  @ApiOkResponse({ type: ProvidersResponse })
  providers(): ProvidersResponse {
    return { providers: this.oauth.enabledProviders() };
  }

  @Public()
  @Get('oauth/:provider/start')
  @ApiOperation({
    summary:
      "Start signing in with a provider (redirects to the provider's page)",
    description:
      "Open this URL in the browser (a link or the address bar), not with fetch or 'Try it out': it ends on the provider's sign-in page.",
  })
  @ApiQuery({
    name: 'returnTo',
    required: false,
    description:
      'Path in the web app to continue to afterwards, e.g. /dashboard.',
  })
  @ApiQuery({
    name: 'terms',
    required: false,
    example: '2026-10-01',
    description:
      'The Terms version shown next to the button; recorded on a new account (or one that has not accepted yet).',
  })
  @ApiFoundResponse()
  async start(
    @Param('provider') provider: string,
    @Query('returnTo') returnTo: string | undefined,
    @Query('terms') terms: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { url, state } = await this.oauth.start(
      provider,
      returnTo,
      undefined,
      terms,
    );
    this.cookies.setOAuthState(res, state);
    res.redirect(HttpStatus.FOUND, url);
  }

  @Post('oauth/:provider/link')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Connect a provider to the signed-in account; returns the URL to open',
  })
  @ApiOkResponse({ type: LinkProviderResponse })
  async link(
    @CurrentUser() user: AuthUser,
    @Param('provider') provider: string,
    @Body() dto: LinkProviderDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LinkProviderResponse> {
    const { url, state } = await this.oauth.start(
      provider,
      dto.returnTo,
      user.id,
    );
    this.cookies.setOAuthState(res, state);
    return { url };
  }

  @Public()
  @Get('oauth/:provider/callback')
  @ApiOperation({
    summary: 'Where the provider sends the user back (not called by the app)',
  })
  @ApiFoundResponse()
  async callback(
    @Param('provider') provider: string,
    @Query() query: { code?: string; state?: string; error?: string },
    @Req() req: Request,
    @Client() client: ClientInfo,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.oauth.callback(
      provider,
      { code: query.code, state: query.state, error: query.error },
      this.cookies.read(req, OAUTH_STATE_COOKIE),
      client,
    );
    this.cookies.clear(res, OAUTH_STATE_COOKIE);

    const params = new URLSearchParams({ next: result.returnTo });
    if (result.kind === 'error') {
      params.set('error', result.error);
    } else if (result.kind === 'linked') {
      params.set('status', 'linked');
      params.set('provider', result.provider);
    } else if (result.outcome.kind === 'mfa_required') {
      this.cookies.setMfaChallenge(res, result.outcome.challenge);
      params.set('status', 'mfa_required');
    } else {
      this.cookies.clear(res, MFA_COOKIE);
      const { session } = result.outcome;
      this.cookies.setRefresh(
        res,
        session.refreshToken,
        session.refreshExpiresAt,
      );
      params.set('status', 'signed_in');
    }
    res.redirect(
      HttpStatus.FOUND,
      `${this.appUrl}/auth/callback?${params.toString()}`,
    );
  }

  @Get('identities')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Providers connected to the signed-in account' })
  @ApiOkResponse({ type: [IdentityResponse] })
  async identities(@CurrentUser() user: AuthUser): Promise<IdentityResponse[]> {
    return (await this.oauth.listIdentities(user.id)).map((identity) => ({
      ...identity,
      createdAt: identity.createdAt.toISOString(),
      lastUsedAt: identity.lastUsedAt?.toISOString() ?? null,
    }));
  }

  @Delete('identities/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Disconnect a provider (not the last way to sign in)',
  })
  @ApiNoContentResponse()
  async unlink(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Client() client: ClientInfo,
  ): Promise<void> {
    await this.oauth.unlink(user.id, id, client);
  }
}
