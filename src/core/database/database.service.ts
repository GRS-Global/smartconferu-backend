import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Database, type Tx } from './database.types.js';

@Injectable()
export class DatabaseService {
  constructor(@Inject(DRIZZLE) readonly db: Database) {}

  /** Runs `work` in one transaction: all of it is committed, or none of it. */
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  /** Throws if the database can't be reached. */
  async ping(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }
}
