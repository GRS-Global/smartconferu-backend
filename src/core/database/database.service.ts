import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  DRIZZLE,
  type Database,
  type Executor,
  type Tx,
} from './database.types.js';

type Hook = () => void | Promise<void>;

@Injectable()
export class DatabaseService {
  private readonly logger = new Logger(DatabaseService.name);
  /** Work to do once each open transaction commits. */
  private readonly afterCommitHooks = new WeakMap<Tx, Hook[]>();

  constructor(@Inject(DRIZZLE) readonly db: Database) {}

  /** Runs `work` in one transaction: all of it is committed, or none of it. */
  async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    const hooks: Hook[] = [];
    const result = await this.db.transaction((tx) => {
      this.afterCommitHooks.set(tx, hooks);
      return work(tx);
    });
    for (const hook of hooks) {
      this.runHook(hook);
    }
    return result;
  }

  /**
   * Runs `hook` once the change is saved: after the transaction commits when `executor` is one
   * opened by transaction(), at once otherwise. Never on a rollback. For side effects outside the
   * database (pushing a live event); a failing hook is only logged.
   */
  afterCommit(executor: Executor, hook: Hook): void {
    const hooks = this.afterCommitHooks.get(executor as Tx);
    if (hooks) {
      hooks.push(hook);
    } else {
      this.runHook(hook);
    }
  }

  /** Throws if the database can't be reached. */
  async ping(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }

  private runHook(hook: Hook): void {
    void Promise.resolve()
      .then(hook)
      .catch((error: unknown) =>
        this.logger.warn({ err: error }, 'After-commit hook failed'),
      );
  }
}
