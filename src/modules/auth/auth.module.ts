import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { AccountController } from './account.controller.js';
import { AccountService } from './account.service.js';
import { AuthCookies } from './auth-cookies.js';
import { AuthController } from './auth.controller.js';
import { AuthRepository } from './auth.repository.js';
import { AuthService } from './auth.service.js';
import { MfaService } from './mfa.service.js';
import { OAuthController } from './oauth/oauth.controller.js';
import { OAuthService } from './oauth/oauth.service.js';
import { OAuthProviders } from './oauth/providers.js';
import { OneTimeTokensService } from './one-time-tokens.service.js';
import { SessionsService } from './sessions.service.js';

@Module({
  imports: [UsersModule],
  controllers: [AuthController, OAuthController, AccountController],
  providers: [
    AuthService,
    AccountService,
    AuthRepository,
    AuthCookies,
    SessionsService,
    OneTimeTokensService,
    MfaService,
    OAuthProviders,
    OAuthService,
  ],
})
export class AuthModule {}
