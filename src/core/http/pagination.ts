import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { AppException } from '../errors/app.exception.js';

/** `?limit=&cursor=` on every list that pages. */
export class PageQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description: 'The `nextCursor` of the previous page.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}

/** Where a newest-first page stopped: the last row's time and id. */
export interface Cursor {
  at: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.at.toISOString()}|${cursor.id}`).toString(
    'base64url',
  );
}

/** The cursor a client sent back; 400 when it isn't one of ours. */
export function decodeCursor(value: string | undefined): Cursor | undefined {
  if (!value) {
    return undefined;
  }
  const [at, id] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  const date = new Date(at ?? '');
  if (!id || !UUID.test(id) || Number.isNaN(date.getTime())) {
    throw AppException.validation('Unknown cursor.');
  }
  return { at: date, id };
}

/**
 * One page from rows read with `limit + 1`: the extra row only says there is a next page.
 */
export function page<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => Cursor,
): { data: T[]; nextCursor: string | null } {
  const data = rows.slice(0, limit);
  const last = data.at(-1);
  return {
    data,
    nextCursor:
      rows.length > limit && last ? encodeCursor(cursorOf(last)) : null,
  };
}

/**
 * Keyset paging on (created time, id). Postgres keeps microseconds but a cursor (a JS Date) only
 * milliseconds, so both the order and the comparison use the time cut to milliseconds: rows saved
 * in one transaction share a time and would otherwise be skipped at a page edge.
 */
export function keyset(
  at: AnyPgColumn,
  id: AnyPgColumn,
  cursor: Cursor | undefined,
  direction: 'newest-first' | 'oldest-first',
): { where: SQL | undefined; orderBy: SQL[] } {
  const ms = sql`date_trunc('milliseconds', ${at})`;
  const op = direction === 'newest-first' ? sql`<` : sql`>`;
  const dir = direction === 'newest-first' ? sql`desc` : sql`asc`;
  return {
    where: cursor
      ? sql`(${ms}, ${id}) ${op} (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`
      : undefined,
    orderBy: [sql`${ms} ${dir}`, sql`${id} ${dir}`],
  };
}
