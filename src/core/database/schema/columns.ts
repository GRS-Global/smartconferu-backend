import { timestamp } from 'drizzle-orm/pg-core';

/** `timestamptz`, read and written as a JS Date. */
export const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });

export const createdAt = () => timestamptz('created_at').defaultNow().notNull();

/** Set on insert by the database and on every update by Drizzle. */
export const updatedAt = () =>
  timestamptz('updated_at')
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date());
