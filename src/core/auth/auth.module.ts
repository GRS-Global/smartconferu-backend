import { Global, Module } from '@nestjs/common';
import { AccessTokenService } from './access-token.service.js';
import { JwksController } from './jwks.controller.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { PasswordService } from './password.service.js';

/** Token verification and password hashing, used app-wide. The sign-in flows live in modules/auth. */
@Global()
@Module({
  controllers: [JwksController],
  providers: [AccessTokenService, PasswordService, JwtAuthGuard],
  exports: [AccessTokenService, PasswordService, JwtAuthGuard],
})
export class AuthCoreModule {}
