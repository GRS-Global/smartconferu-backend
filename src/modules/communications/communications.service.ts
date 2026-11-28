import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Executor } from '../../core/database/database.types.js';
import {
  conferenceEmailTemplates,
  conferenceMembers,
  emailLog,
  emailTemplates,
  profiles,
  submissionAuthors,
  submissions,
} from '../../core/database/schema/index.js';
import { EmailQueueService } from '../../core/email/email-queue.service.js';
import type { WrittenEmail } from '../../core/email/email-queue.service.js';
import { EmailRecipientsService } from '../../core/email/email-recipients.service.js';
import {
  emailDate,
  renderTemplate,
  stripTags,
  VALID_EMAIL,
} from '../../core/email/email-render.js';
import { EMAIL_SAMPLE_VALUES } from '../../core/email/email-samples.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import { decodeCursor, keyset, page } from '../../core/http/pagination.js';
import * as rules from '../../core/rbac/access-rules.js';
import { AccessService } from '../../core/rbac/access.service.js';
import { paperId } from '../submissions/submission.mapper.js';
import { SubmissionsRepository } from '../submissions/submissions.repository.js';
import {
  type Audience,
  type ConferenceTemplatesResponse,
  CUSTOM_KEY,
  CUSTOM_PREFIX,
  type CustomEmailQueuedResponse,
  type EmailLogEntry,
  type EmailLogPage,
  type EmailLogQuery,
  type PlatformTemplateResponse,
  type SendCustomEmailDto,
  type UpdateConferenceTemplateDto,
  type UpdatePlatformTemplateDto,
} from './dto/communications.dto.js';
import { appPaths } from '../../core/http/app-paths.js';

const MAX_CUSTOM_RECIPIENTS = 2000;
const TOLD_ACCEPTED = ['accept', 'registered'];
const TOLD_FINAL = ['accept', 'registered', 'reject'];

type PlatformRow = typeof emailTemplates.$inferSelect;

const toPlatform = (t: PlatformRow): PlatformTemplateResponse => ({
  key: t.key,
  module: t.module,
  role: t.role,
  label: t.label,
  sendType: t.sendType,
  triggerText: t.triggerText,
  recipients: t.recipients,
  subject: t.subject,
  body: t.body,
  updatedAt: t.updatedAt.toISOString(),
});

/** Strips "Dr." and friends and splits a name: the first_name / last_name placeholders. */
function nameParts(name: string, email: string) {
  const [first, ...rest] = name
    .replace(/^(Dr\.?|Prof\.?|Mr\.?|Ms\.?|Mrs\.?)\s+/i, '')
    .trim()
    .split(/\s+/);
  return {
    first_name: first || email.split('@')[0] || 'there',
    last_name: rest.join(' '),
  };
}

/**
 * Email Templates (the platform's defaults and each conference's own copies and custom emails),
 * Email Logs, and the chair's own emails (Email Communication › Send Email).
 *
 * Replaces: copy_email_templates reads, the app's direct writes to email_templates and
 * conference_email_templates, the email_log reads, and the custom_email / template_test events of
 * the old send-email function.
 */
@Injectable()
export class CommunicationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly submissions: SubmissionsRepository,
    private readonly emails: EmailQueueService,
    private readonly recipients: EmailRecipientsService,
    private readonly audit: AuditService,
  ) {}

  // A conference's templates --------------------------------------------------------------------

  async conferenceTemplates(
    user: AuthUser,
    conferenceId: string,
  ): Promise<ConferenceTemplatesResponse> {
    await this.requireChair(user, conferenceId, this.database.db);
    return this.readConferenceTemplates(this.database.db, conferenceId);
  }

  /**
   * Changes the conference's copy of a platform email (on/off, subject, body), or creates or
   * changes one of its custom emails (`custom:<id>`). Account emails always use the platform's.
   */
  async updateConferenceTemplate(
    user: AuthUser,
    conferenceId: string,
    key: string,
    dto: UpdateConferenceTemplateDto,
    client: ClientInfo,
  ): Promise<ConferenceTemplatesResponse> {
    return this.database.transaction(async (tx) => {
      await this.requireChair(user, conferenceId, tx);
      const custom = key.startsWith(CUSTOM_PREFIX);
      if (custom && !CUSTOM_KEY.test(key)) {
        throw AppException.validation(
          'A custom email key is "custom:" and up to 64 letters, digits, "-" or "_".',
        );
      }
      const base = custom
        ? undefined
        : (
            await tx
              .select()
              .from(emailTemplates)
              .where(eq(emailTemplates.key, key))
          )[0];
      if (!custom && !base) {
        throw AppException.notFound('The email template');
      }
      if (base?.module === 'account') {
        throw AppException.businessRule(
          'Account emails are the same for every conference; a Super Admin changes them.',
        );
      }
      const [current] = await tx
        .select()
        .from(conferenceEmailTemplates)
        .where(
          and(
            eq(conferenceEmailTemplates.conferenceId, conferenceId),
            eq(conferenceEmailTemplates.key, key),
          ),
        );
      const values = {
        enabled: dto.enabled ?? current?.enabled ?? true,
        subject: dto.subject ?? current?.subject ?? base?.subject ?? '',
        body: dto.body ?? current?.body ?? base?.body ?? '',
        label: custom
          ? (dto.label ?? current?.label ?? 'Untitled Email') ||
            'Untitled Email'
          : (current?.label ?? base?.label ?? null),
        isCustom: custom,
        updatedBy: user.id,
      };
      await tx
        .insert(conferenceEmailTemplates)
        .values({ conferenceId, key, ...values })
        .onConflictDoUpdate({
          target: [
            conferenceEmailTemplates.conferenceId,
            conferenceEmailTemplates.key,
          ],
          set: { ...values, updatedAt: new Date() },
        });
      await this.audit.record(
        {
          action: 'conference.email_template_updated',
          actorId: user.id,
          entityType: 'conference',
          entityId: conferenceId,
          client,
          data: { key, enabled: values.enabled },
        },
        tx,
      );
      return this.readConferenceTemplates(tx, conferenceId);
    });
  }

  /** Deletes a custom email, or puts a platform email back to the platform default. */
  async resetConferenceTemplate(
    user: AuthUser,
    conferenceId: string,
    key: string,
    client: ClientInfo,
  ): Promise<ConferenceTemplatesResponse> {
    return this.database.transaction(async (tx) => {
      await this.requireChair(user, conferenceId, tx);
      const where = and(
        eq(conferenceEmailTemplates.conferenceId, conferenceId),
        eq(conferenceEmailTemplates.key, key),
      );
      if (key.startsWith(CUSTOM_PREFIX)) {
        const gone = await tx
          .delete(conferenceEmailTemplates)
          .where(where)
          .returning({ key: conferenceEmailTemplates.key });
        if (gone.length === 0) {
          throw AppException.notFound('The email');
        }
      } else {
        const [base] = await tx
          .select()
          .from(emailTemplates)
          .where(eq(emailTemplates.key, key));
        if (!base) {
          throw AppException.notFound('The email template');
        }
        await tx
          .update(conferenceEmailTemplates)
          .set({
            subject: base.subject,
            body: base.body,
            label: base.label,
            enabled: true,
            updatedBy: user.id,
            updatedAt: new Date(),
          })
          .where(where);
      }
      await this.audit.record(
        {
          action: 'conference.email_template_reset',
          actorId: user.id,
          entityType: 'conference',
          entityId: conferenceId,
          client,
          data: { key },
        },
        tx,
      );
      return this.readConferenceTemplates(tx, conferenceId);
    });
  }

  private async readConferenceTemplates(
    executor: Executor,
    conferenceId: string,
  ): Promise<ConferenceTemplatesResponse> {
    const platform = await executor
      .select()
      .from(emailTemplates)
      .orderBy(asc(emailTemplates.module), asc(emailTemplates.key));
    const own = await executor
      .select()
      .from(conferenceEmailTemplates)
      .where(eq(conferenceEmailTemplates.conferenceId, conferenceId))
      .orderBy(asc(conferenceEmailTemplates.updatedAt));
    const copies = new Map(own.map((c) => [c.key, c]));
    return {
      templates: platform
        .filter((t) => t.module !== 'account')
        .map((t) => {
          const copy = copies.get(t.key);
          const subject = copy?.subject.trim() ? copy.subject : t.subject;
          const body = copy?.body.trim() ? copy.body : t.body;
          return Object.assign(toPlatform(t), {
            subject,
            body,
            updatedAt: (copy?.updatedAt ?? t.updatedAt).toISOString(),
            enabled: copy?.enabled ?? true,
            customized: subject !== t.subject || body !== t.body,
            defaultSubject: t.subject,
            defaultBody: t.body,
          });
        }),
      customEmails: own
        .filter((c) => c.isCustom || c.key.startsWith(CUSTOM_PREFIX))
        .map((c) => ({
          key: c.key,
          id: c.key.slice(CUSTOM_PREFIX.length),
          name: c.label ?? '',
          enabled: c.enabled,
          subject: c.subject,
          body: c.body,
          updatedAt: c.updatedAt.toISOString(),
        })),
    };
  }

  // Email Logs ----------------------------------------------------------------------------------

  /** The conference's emails, newest first (chairs). */
  async conferenceLog(
    user: AuthUser,
    conferenceId: string,
    query: EmailLogQuery,
  ): Promise<EmailLogPage> {
    const access = await this.access.requireConference(user, conferenceId);
    if (!rules.canViewEmailLog(access)) {
      throw AppException.forbidden(
        'Only a chair of this conference can see its Email Logs.',
      );
    }
    return this.log(query, eq(emailLog.conferenceId, conferenceId));
  }

  /** Every email the platform sent (super admins), optionally one conference's. */
  platformLog(
    query: EmailLogQuery & { conferenceId?: string },
  ): Promise<EmailLogPage> {
    return this.log(
      query,
      query.conferenceId
        ? eq(emailLog.conferenceId, query.conferenceId)
        : undefined,
    );
  }

  private async log(
    query: EmailLogQuery,
    scope: SQL | undefined,
  ): Promise<EmailLogPage> {
    const limit = query.limit ?? 50;
    const order = keyset(
      emailLog.createdAt,
      emailLog.id,
      decodeCursor(query.cursor),
      'newest-first',
    );
    const sender = sql<
      string | null
    >`nullif(trim(${profiles.firstName} || ' ' || ${profiles.lastName}), '')`;
    const rows = await this.database.db
      .select({ row: emailLog, sentByName: sender })
      .from(emailLog)
      .leftJoin(profiles, eq(profiles.id, emailLog.sentBy))
      .where(
        and(
          scope,
          query.status ? eq(emailLog.status, query.status) : undefined,
          query.submissionId
            ? eq(emailLog.submissionId, query.submissionId)
            : undefined,
          query.templateKey
            ? eq(emailLog.templateKey, query.templateKey)
            : undefined,
          order.where,
        ),
      )
      .orderBy(...order.orderBy)
      .limit(limit + 1);
    const result = page(rows, limit, (r) => ({
      at: r.row.createdAt,
      id: r.row.id,
    }));
    return {
      data: result.data.map(({ row, sentByName }): EmailLogEntry => ({
        id: row.id,
        conferenceId: row.conferenceId,
        submissionId: row.submissionId,
        event: row.event,
        templateKey: row.templateKey,
        templateLabel: row.templateLabel,
        toEmail: row.toEmail,
        toName: row.toName,
        recipientType: row.recipientType,
        subject: row.subject,
        body: row.body,
        status: row.status,
        attempts: row.attempts,
        error: row.error,
        sentAt: row.sentAt?.toISOString() ?? null,
        sentByName,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
    };
  }

  // The chair's own emails ----------------------------------------------------------------------

  /**
   * Email Communication › Send Email: the chair's message to the chosen audiences. Each person gets
   * it once, with their own placeholders filled in (their name, and their paper when they have one).
   */
  async sendCustom(
    user: AuthUser,
    conferenceId: string,
    dto: SendCustomEmailDto,
    client: ClientInfo,
  ): Promise<CustomEmailQueuedResponse> {
    if (!stripTags(dto.body)) {
      throw AppException.validation('The email needs a message.');
    }
    return this.database.transaction(async (tx) => {
      await this.requireChair(user, conferenceId, tx);
      const info = (await this.submissions.conferenceInfo(tx, conferenceId))!;
      const conference = await this.recipients.conference(tx, conferenceId);

      type Paper = {
        id: string;
        paperNo: number;
        title: string;
        details: unknown;
      };
      const people = new Map<
        string,
        {
          to: { email: string; name: string };
          recipientType: string;
          papers: Paper[];
        }
      >();
      const add = (
        email: string,
        name: string,
        recipientType: string,
        paper?: Paper,
      ) => {
        const address = email.trim();
        if (!VALID_EMAIL.test(address)) {
          return;
        }
        const key = address.toLowerCase();
        const entry = people.get(key) ?? {
          to: { email: address, name },
          recipientType,
          papers: [],
        };
        if (paper && !entry.papers.some((p) => p.id === paper.id)) {
          entry.papers.push(paper);
        }
        if (!entry.to.name && name) {
          entry.to.name = name;
        }
        people.set(key, entry);
      };

      const authorAudiences = dto.audiences.filter((a) => a !== 'reviewers');
      if (authorAudiences.length > 0) {
        const papers = await tx
          .select({
            id: submissions.id,
            paperNo: submissions.paperNo,
            title: submissions.title,
            details: submissions.details,
            notifiedOutcome: submissions.notifiedOutcome,
          })
          .from(submissions)
          .where(
            and(
              eq(submissions.conferenceId, conferenceId),
              eq(submissions.status, 'submitted'),
            ),
          )
          .orderBy(asc(submissions.paperNo));
        const authorRows =
          papers.length > 0
            ? await tx
                .select({
                  submissionId: submissionAuthors.submissionId,
                  name: submissionAuthors.name,
                  email: submissionAuthors.email,
                  corresponding: submissionAuthors.isCorresponding,
                })
                .from(submissionAuthors)
                .where(
                  inArray(
                    submissionAuthors.submissionId,
                    papers.map((p) => p.id),
                  ),
                )
                .orderBy(asc(submissionAuthors.position))
            : [];
        const picks: Record<
          Exclude<Audience, 'reviewers'>,
          (told: string | null) => boolean
        > = {
          all_authors: () => true,
          corresponding_authors: () => true,
          accepted_authors: (told) =>
            told !== null && TOLD_ACCEPTED.includes(told),
          under_review_authors: (told) =>
            told === null || !TOLD_FINAL.includes(told),
        };
        for (const audience of authorAudiences as Exclude<
          Audience,
          'reviewers'
        >[]) {
          for (const paper of papers.filter((p) =>
            picks[audience](p.notifiedOutcome),
          )) {
            for (const a of authorRows) {
              if (
                a.email &&
                a.submissionId === paper.id &&
                (audience !== 'corresponding_authors' || a.corresponding)
              ) {
                add(a.email, a.name, 'Author', paper);
              }
            }
          }
        }
      }
      if (dto.audiences.includes('reviewers')) {
        const reviewers = await tx
          .select({ userId: conferenceMembers.userId })
          .from(conferenceMembers)
          .where(
            and(
              eq(conferenceMembers.conferenceId, conferenceId),
              eq(conferenceMembers.role, 'reviewer'),
              eq(conferenceMembers.status, 'active'),
            ),
          );
        const found = await this.recipients.people(
          tx,
          reviewers.flatMap((r) => (r.userId ? [r.userId] : [])),
        );
        for (const p of found.values()) {
          add(p.email, p.name, 'Reviewer');
        }
      }
      if (people.size > MAX_CUSTOM_RECIPIENTS) {
        throw AppException.businessRule(
          `That's ${people.size} people — one email can go to at most ${MAX_CUSTOM_RECIPIENTS}.`,
        );
      }
      if (people.size === 0) {
        throw AppException.businessRule(
          'Nobody in these groups has an email address yet.',
        );
      }

      const label = dto.templateLabel?.trim() || 'Email from the chair';
      const emails = [...people.values()].map(
        ({ to, recipientType, papers }): WrittenEmail => {
          const one = papers.length === 1 ? papers[0] : undefined;
          const details = (one?.details ?? {}) as Record<string, unknown>;
          const pid = one ? paperId(info.acronym, one.paperNo) : '';
          const values = {
            conference_name: conference.title,
            conference_acronym: conference.acronym,
            ...nameParts(to.name, to.email),
            deadline: emailDate(info.submissionDeadline),
            paper_title: papers.map((p) => p.title).join('; '),
            submission_id: papers
              .map((p) => paperId(info.acronym, p.paperNo))
              .join(', '),
            track: typeof details.track === 'string' ? details.track : '',
            presentation_type:
              typeof details.presentationType === 'string'
                ? details.presentationType
                : '',
            submission_link: pid
              ? this.recipients.link(appPaths.authorPaper(conference.slug, pid))
              : this.recipients.link('/'),
          };
          return {
            key: 'custom',
            label,
            recipientType,
            conference,
            submissionId: one?.id ?? null,
            to,
            subject: renderTemplate(dto.subject, values, { html: false }),
            body: renderTemplate(dto.body, values, { html: true }),
          };
        },
      );
      const result = await this.emails.enqueue(tx, 'custom_email', emails, {
        sentBy: user.id,
      });
      await this.audit.record(
        {
          action: 'conference.custom_email_sent',
          actorId: user.id,
          entityType: 'conference',
          entityId: conferenceId,
          client,
          data: { audiences: dto.audiences, label, queued: result.queued },
        },
        tx,
      );
      return result;
    });
  }

  // The platform's templates (super admins) -----------------------------------------------------

  async platformTemplates(): Promise<PlatformTemplateResponse[]> {
    const rows = await this.database.db
      .select()
      .from(emailTemplates)
      .orderBy(asc(emailTemplates.module), asc(emailTemplates.key));
    return rows.map(toPlatform);
  }

  /**
   * Changes a platform default. Conferences approved from now on get it in their copy; conferences
   * whose copy still has the old default text follow the new default too (an unchanged copy is
   * moved along with it).
   */
  async updatePlatformTemplate(
    user: AuthUser,
    key: string,
    dto: UpdatePlatformTemplateDto,
    client: ClientInfo,
  ): Promise<PlatformTemplateResponse> {
    return this.database.transaction(async (tx) => {
      const [base] = await tx
        .select()
        .from(emailTemplates)
        .where(eq(emailTemplates.key, key))
        .for('update');
      if (!base) {
        throw AppException.notFound('The email template');
      }
      const [row] = await tx
        .update(emailTemplates)
        .set({
          subject: dto.subject,
          body: dto.body,
          updatedBy: user.id,
          updatedAt: new Date(),
        })
        .where(eq(emailTemplates.key, key))
        .returning();
      // Copies nobody changed keep following the platform default.
      await tx
        .update(conferenceEmailTemplates)
        .set({ subject: dto.subject, body: dto.body, updatedAt: new Date() })
        .where(
          and(
            eq(conferenceEmailTemplates.key, key),
            eq(conferenceEmailTemplates.subject, base.subject),
            eq(conferenceEmailTemplates.body, base.body),
          ),
        );
      await this.audit.record(
        {
          action: 'admin.email_template_updated',
          actorId: user.id,
          entityType: 'email_template',
          client,
          data: { key },
        },
        tx,
      );
      return toPlatform(row);
    });
  }

  /** "Send me a test": the template (or an unsaved edit of it) with example values, to the admin. */
  async testTemplate(
    user: AuthUser,
    key: string,
    edit: { subject?: string; body?: string },
  ): Promise<CustomEmailQueuedResponse> {
    return this.database.transaction(async (tx) => {
      const [base] = await tx
        .select()
        .from(emailTemplates)
        .where(eq(emailTemplates.key, key));
      if (!base) {
        throw AppException.notFound('The email template');
      }
      const me = (await this.recipients.people(tx, [user.id])).get(user.id);
      if (!me) {
        throw AppException.businessRule(
          'Your account has no email address to send the test to.',
        );
      }
      const subject = edit.subject?.trim() || base.subject;
      const body = stripTags(edit.body) ? edit.body! : base.body;
      return this.emails.enqueue(
        tx,
        'template_test',
        {
          key,
          label: `Test: ${base.label}`,
          recipientType: 'Super Admin',
          to: { email: me.email, name: me.name },
          subject: `[Test] ${renderTemplate(subject, EMAIL_SAMPLE_VALUES, { html: false })}`,
          body: renderTemplate(body, EMAIL_SAMPLE_VALUES, { html: true }),
        },
        { sentBy: user.id },
      );
    });
  }

  // Helpers -----------------------------------------------------------------------------------

  private async requireChair(
    user: AuthUser,
    conferenceId: string,
    executor: Executor,
  ) {
    const access = await this.access.requireConference(
      user,
      conferenceId,
      executor,
    );
    if (!rules.canManageEmailTemplates(access)) {
      throw AppException.forbidden(
        'Only a chair of this conference can manage its emails.',
      );
    }
    return access;
  }
}
