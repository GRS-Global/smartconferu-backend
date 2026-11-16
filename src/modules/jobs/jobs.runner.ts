import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lt, sql } from 'drizzle-orm';
import type { Env } from '../../config/env.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Tx } from '../../core/database/database.types.js';
import { authTokens, sessions } from '../../core/database/schema/index.js';
import { PaperRagService } from '../ai/paper-rag.service.js';
import {
  type ReminderRun,
  ReviewRemindersService,
} from '../reviews/reminders/review-reminders.service.js';

/** Expired sign-in links, codes and sessions are kept this long (for support), then deleted. */
const KEEP_EXPIRED_MS = 7 * 86_400_000;

/** One Postgres advisory lock per job, so only one API instance runs it at a time. */
const LOCKS = { reviewReminders: 7_201_001, cleanup: 7_201_002 } as const;

export interface JobsResult {
  /** null when another instance was running it. */
  reviewReminders: ReminderRun | null;
  cleanup: { authTokens: number; sessions: number } | null;
  /** Papers prepared for AI that weren't yet (none when AI isn't set up). */
  paperAi: { prepared: number; failed: number };
}

/**
 * The background jobs, run from the API process every JOBS_INTERVAL_MS (and once shortly after
 * start): the review reminders, the cleanup of expired tokens, and preparing papers for AI that
 * were missed (an upload while AI was down). The first two run in their own
 * transaction under an advisory lock, so several API instances never run one twice at once, and
 * each job is safe to run more often than needed.
 */
@Injectable()
export class JobsRunner
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(JobsRunner.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  private running?: Promise<JobsResult>;

  constructor(
    private readonly database: DatabaseService,
    private readonly reminders: ReviewRemindersService,
    private readonly rag: PaperRagService,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('JOBS_ENABLED', { infer: true });
    this.intervalMs = config.get('JOBS_INTERVAL_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      return;
    }
    const tick = () => {
      void this.runAll().catch((error: unknown) =>
        this.logger.error({ err: error }, 'Background jobs failed'),
      );
    };
    this.first = setTimeout(tick, 30_000);
    this.first.unref();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    clearTimeout(this.first);
    clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }

  /** Runs every job now (one run at a time in this process). */
  runAll(now: Date = new Date()): Promise<JobsResult> {
    if (!this.running) {
      this.running = this.runJobs(now).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  private async runJobs(now: Date): Promise<JobsResult> {
    const reviewReminders = await this.locked(LOCKS.reviewReminders, (tx) =>
      this.reminders.run(tx, now),
    );
    const cleanup = await this.locked(LOCKS.cleanup, (tx) =>
      this.cleanup(tx, now),
    );
    // Long AI calls: no transaction held open. Two instances may both prepare a paper; the second
    // write replaces the first.
    const paperAi = await this.rag.ingestBacklog();
    if (reviewReminders?.queued) {
      this.logger.log(
        { reminders: reviewReminders.queued },
        'Review reminders queued',
      );
    }
    return { reviewReminders, cleanup, paperAi };
  }

  private async cleanup(tx: Tx, now: Date) {
    const before = new Date(now.getTime() - KEEP_EXPIRED_MS);
    const tokens = await tx
      .delete(authTokens)
      .where(lt(authTokens.expiresAt, before))
      .returning({ id: authTokens.id });
    const gone = await tx
      .delete(sessions)
      .where(lt(sessions.expiresAt, before))
      .returning({ id: sessions.id });
    return { authTokens: tokens.length, sessions: gone.length };
  }

  /** Runs `job` in a transaction holding the lock; null when another instance holds it. */
  private locked<T>(
    lock: number,
    job: (tx: Tx) => Promise<T>,
  ): Promise<T | null> {
    return this.database.transaction(async (tx) => {
      const [row] = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(${lock}) as locked`,
      );
      return row?.locked ? job(tx) : null;
    });
  }
}
