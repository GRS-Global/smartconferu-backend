import { type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Env } from '../../config/env.js';

/** The standard rate limiter, switched off when RATE_LIMIT_ENABLED=false (automated API tests). */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  // Property injection: the parent's constructor parameters stay as the library defines them.
  @Inject(ConfigService)
  private readonly config: ConfigService<Env, true>;

  protected override async shouldSkip(
    context: ExecutionContext,
  ): Promise<boolean> {
    return (
      !this.config.get('RATE_LIMIT_ENABLED', { infer: true }) ||
      super.shouldSkip(context)
    );
  }
}
