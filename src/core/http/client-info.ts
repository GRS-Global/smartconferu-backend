import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Where a request came from, for the audit log and session list. */
export interface ClientInfo {
  ipAddress: string | null;
  userAgent: string | null;
}

export const Client = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ClientInfo => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return {
      // `trust proxy` is set, so this is the caller's address, not the load balancer's.
      ipAddress: request.ip ?? null,
      userAgent: request.headers['user-agent']?.slice(0, 512) ?? null,
    };
  },
);
