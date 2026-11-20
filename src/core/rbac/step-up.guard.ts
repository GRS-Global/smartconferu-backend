import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Request } from 'express';
import { DatabaseService } from '../database/database.service.js';
import { sessions } from '../database/schema/index.js';
import { AppException, ErrorCode } from '../errors/app.exception.js';

/** How long one "Confirm it's you" code covers further high-risk actions. */
export const STEP_UP_MINUTES = 10;

/**
 * High-risk admin actions (suspending, merging, resetting two-step, extending a license, team
 * changes…) need a fresh second-factor code in this session: `POST /auth/step-up` within the last
 * STEP_UP_MINUTES. Otherwise 403 AUTH_STEP_UP_REQUIRED, and the console asks for a code and retries.
 */
@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(private readonly database: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest<Request>().user;
    if (!user) {
      throw AppException.forbidden();
    }
    const since = new Date(Date.now() - STEP_UP_MINUTES * 60_000);
    const [fresh] = await this.database.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.familyId, user.sessionId),
          eq(sessions.userId, user.id),
          isNull(sessions.revokedAt),
          gt(sessions.stepUpAt, since),
        ),
      )
      .limit(1);
    if (!fresh) {
      throw new AppException(
        HttpStatus.FORBIDDEN,
        ErrorCode.AUTH_STEP_UP_REQUIRED,
        'Confirm it’s you: enter a fresh 6-digit code to do this.',
      );
    }
    return true;
  }
}

/** Needs a "Confirm it's you" code from the last 10 minutes (put it after @SuperAdminOnly()). */
export const StepUp = () => UseGuards(StepUpGuard);
