import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException, ErrorCode } from '../errors/app.exception.js';
import { AccessTokenService } from './access-token.service.js';
import { IS_PUBLIC } from './auth.decorators.js';

/** Global guard: every route needs a valid access token unless marked @Public(). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = /^Bearer\s+(\S+)$/i.exec(
      request.headers.authorization ?? '',
    )?.[1];
    if (!token) {
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.AUTH_REQUIRED,
        'Sign in to continue.',
      );
    }
    try {
      request.user = await this.tokens.verify(token);
    } catch {
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.AUTH_INVALID_TOKEN,
        'Your session has expired. Please sign in again.',
      );
    }
    return true;
  }
}
