import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JWK } from 'jose';
import { AccessTokenService } from './access-token.service.js';
import { Public } from './auth.decorators.js';

/** Public keys that verify our access tokens, for other services (standard JWKS location). */
@ApiExcludeController()
@Public()
@SkipThrottle()
@Controller('.well-known')
export class JwksController {
  constructor(private readonly tokens: AccessTokenService) {}

  @Get('jwks.json')
  jwks(): Promise<{ keys: JWK[] }> {
    return this.tokens.jwks();
  }
}
