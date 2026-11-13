import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Env } from '../../config/env.js';
import type { Executor } from '../database/database.types.js';
import {
  conferenceMembers,
  conferences,
  emailLog,
  profiles,
  users,
} from '../database/schema/index.js';
import { firstName, VALID_EMAIL } from './email-render.js';
import type { EmailConference, TemplateEmail } from './email-queue.service.js';

export interface Person {
  userId?: string | null;
  email: string;
  name: string;
}

/**
 * The people emails usually go to, and links into the app. Shared by every module that sends email.
 */
@Injectable()
export class EmailRecipientsService {
  private readonly appUrl: string;

  constructor(config: ConfigService<Env, true>) {
    this.appUrl = config.get('APP_URL', { infer: true }).replace(/\/$/, '');
  }

  /** A full link into the app, e.g. link('/prototype/dashboard'). */
  link(path: string): string {
    return `${this.appUrl}${path}`;
  }

  async conference(
    executor: Executor,
    conferenceId: string,
  ): Promise<EmailConference & { slug: string }> {
    const [row] = await executor
      .select({
        id: conferences.id,
        slug: conferences.slug,
        title: conferences.title,
        acronym: conferences.acronym,
        contactEmail: conferences.contactEmail,
      })
      .from(conferences)
      .where(eq(conferences.id, conferenceId));
    if (!row) {
      throw new Error(`Conference ${conferenceId} not found`);
    }
    return row;
  }

  /** Active accounts with these ids, with their names. */
  async people(
    executor: Executor,
    userIds: readonly string[],
  ): Promise<Map<string, Person>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await executor
      .select({
        userId: users.id,
        email: users.email,
        firstName: profiles.firstName,
        lastName: profiles.lastName,
      })
      .from(users)
      .leftJoin(profiles, eq(profiles.id, users.id))
      .where(and(inArray(users.id, ids), eq(users.status, 'active')));
    return new Map(
      rows
        .filter((r) => r.email)
        .map((r) => [
          r.userId,
          {
            userId: r.userId,
            email: r.email!,
            name:
              [r.firstName, r.lastName].filter(Boolean).join(' ').trim() ||
              r.email!,
          },
        ]),
    );
  }

  /** The conference's active chairs and track chairs. */
  async chairs(executor: Executor, conferenceId: string): Promise<Person[]> {
    const rows = await executor
      .selectDistinct({ userId: conferenceMembers.userId })
      .from(conferenceMembers)
      .where(
        and(
          eq(conferenceMembers.conferenceId, conferenceId),
          inArray(conferenceMembers.role, ['chair', 'track_chair']),
          eq(conferenceMembers.status, 'active'),
        ),
      );
    const people = await this.people(
      executor,
      rows.flatMap((r) => (r.userId ? [r.userId] : [])),
    );
    return [...people.values()];
  }

  async superAdmins(executor: Executor): Promise<Person[]> {
    const rows = await executor
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.isSuperAdmin, true), eq(users.status, 'active')));
    return [
      ...(
        await this.people(
          executor,
          rows.map((r) => r.id),
        )
      ).values(),
    ];
  }

  /**
   * The "Welcome to Smartconferu" email for people just invited or added (as a reviewer, a
   * co-author) who have no account yet and were never welcomed, so someone added to ten papers is
   * welcomed once.
   */
  async welcomeEmails(
    executor: Executor,
    people: readonly { email: string; name?: string | null }[],
  ): Promise<TemplateEmail[]> {
    const byEmail = new Map<string, { email: string; name?: string | null }>();
    for (const person of people) {
      const email = person.email.trim();
      if (VALID_EMAIL.test(email) && !byEmail.has(email.toLowerCase())) {
        byEmail.set(email.toLowerCase(), { ...person, email });
      }
    }
    if (byEmail.size === 0) {
      return [];
    }
    const addresses = [...byEmail.keys()];
    const known = await executor
      .select({ email: sql<string>`lower(${users.email})` })
      .from(users)
      .where(inArray(sql`lower(${users.email})`, addresses));
    const welcomed = await executor
      .selectDistinct({ email: sql<string>`lower(${emailLog.toEmail})` })
      .from(emailLog)
      .where(
        and(
          eq(emailLog.templateKey, 'welcome'),
          inArray(emailLog.status, ['queued', 'sending', 'sent']),
          inArray(sql`lower(${emailLog.toEmail})`, addresses),
        ),
      );
    const skip = new Set([...known, ...welcomed].map((r) => r.email));
    return [...byEmail.entries()]
      .filter(([key]) => !skip.has(key))
      .map(([, person]) => ({
        template: 'welcome',
        recipientType: 'New user',
        to: { email: person.email, name: person.name ?? null },
        values: {
          first_name: firstName(person.name, person.email),
          profile_link: this.link('/prototype/register'),
        },
      }));
  }
}
