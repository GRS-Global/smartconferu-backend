import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from './auth-user.js';

export const IS_PUBLIC = 'auth:isPublic';

/** Marks a route (or controller) as reachable without signing in. Routes are private by default. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** The signed-in user. Only valid on routes that are not @Public(). */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const user = ctx.switchToHttp().getRequest<Request>().user;
    if (!user) {
      throw new Error(
        '@CurrentUser() used on a route without an authenticated user',
      );
    }
    return user;
  },
);
