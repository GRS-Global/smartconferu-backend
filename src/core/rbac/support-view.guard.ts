import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { AppException, ErrorCode } from '../errors/app.exception.js';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A Super Admin's "View as" token is read-only: anything but a read is refused, and so is the
 * admin console and the account's own security endpoints (even reads), whatever the method.
 */
@Injectable()
export class SupportViewGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (!request.user?.supportViewBy) {
      return true;
    }
    const sensitive =
      request.path.includes('/admin/') || request.path.includes('/auth/');
    // The live-notification ticket is a POST that only reads.
    const readOnlyPost =
      request.method === 'POST' && request.path.endsWith('/me/events/ticket');
    if ((READS.has(request.method) || readOnlyPost) && !sensitive) {
      return true;
    }
    throw new AppException(
      HttpStatus.FORBIDDEN,
      ErrorCode.SUPPORT_VIEW_READ_ONLY,
      'This is a read-only support view: nothing can be saved or sent.',
    );
  }
}
