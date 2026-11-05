import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index.js';

export { schema };
export type Schema = typeof schema;

export type Database = PostgresJsDatabase<Schema>;
/** A transaction handle, as passed to DatabaseService.transaction callbacks. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Either the pool or a transaction: what repository methods accept. */
export type Executor = Database | Tx;

export const DRIZZLE = Symbol('DRIZZLE');
