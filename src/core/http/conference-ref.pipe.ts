import { Injectable, Param, type PipeTransform } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { conferences } from '../database/schema/index.js';
import { AppException } from '../errors/app.exception.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9-]+$/;

/**
 * A conference reference in a URL: its UUID or its slug (e.g. "isbm2026"). Resolves to the UUID, so
 * everything after it works with ids only. An unknown reference is a 404 (same answer as a
 * conference the caller may not see). An absent value (an optional query parameter) stays absent.
 */
@Injectable()
export class ConferenceRefPipe implements PipeTransform<
  string | undefined,
  Promise<string | undefined>
> {
  constructor(private readonly database: DatabaseService) {}

  async transform(value: string | undefined): Promise<string | undefined> {
    if (value === undefined || value === '') return undefined;
    if (UUID.test(value)) return value.toLowerCase();
    const slug = value.toLowerCase();
    if (SLUG.test(slug)) {
      const [row] = await this.database.db
        .select({ id: conferences.id })
        .from(conferences)
        .where(eq(conferences.slug, slug))
        .limit(1);
      if (row) return row.id;
    }
    throw AppException.notFound('The conference');
  }
}

/** `@ConferenceRef()` reads `:conferenceId` from the path as a UUID, accepting the conference slug too. */
export const ConferenceRef = (name = 'conferenceId') =>
  Param(name, ConferenceRefPipe);
