import { Global, Injectable, Module } from '@nestjs/common';
import type { Executor } from '../database/database.types.js';

/** Paid features a conference can have. */
export type PlanFeature = 'autoInitialCheck';

/**
 * Which paid features a conference may use. The one place to check: every feature behind a plan
 * asks here. For now every conference gets every feature for free; when plans and payments arrive,
 * this reads the conference's plan instead and nothing else changes.
 */
@Injectable()
export class PlanService {
  hasFeature(
    _executor: Executor,
    _conferenceId: string,
    _feature: PlanFeature,
  ): Promise<boolean> {
    return Promise.resolve(true);
  }
}

@Global()
@Module({ providers: [PlanService], exports: [PlanService] })
export class PlanModule {}
