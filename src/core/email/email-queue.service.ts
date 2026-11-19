import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, inArray } from 'drizzle-orm';
import type { Env } from '../../config/env.js';
import type { Executor } from '../database/database.types.js';
import {
  conferenceEmailTemplates,
  emailLog,
  emailTemplates,
} from '../database/schema/index.js';
import {
  emailLogoUrl,
  frameEmail,
  htmlToText,
  renderTemplate,
  type TemplateValues,
  VALID_EMAIL,
} from './email-render.js';

/** The conference an email is about: its templates are used, its name fills the frame. */
export interface EmailConference {
  id: string;
  title: string;
  acronym: string;
  contactEmail?: string | null;
}

interface EmailBase {
  to: { email: string; name?: string | null };
  /** Who the person is to this email, for Email Logs ("Author", "Chair", "Reviewer"…). */
  recipientType?: string;
  conference?: EmailConference | null;
  submissionId?: string | null;
}

/** An email from a template (the conference's copy, else the platform default). */
export interface TemplateEmail extends EmailBase {
  template: string;
  values?: TemplateValues;
}

/** An email whose subject and HTML body are written by the caller (a chair's own message). */
export interface WrittenEmail extends EmailBase {
  /** Recorded as the template key in Email Logs, e.g. "custom". */
  key: string;
  label: string;
  subject: string;
  body: string;
}

export type OutgoingEmail = TemplateEmail | WrittenEmail;

export interface QueueResult {
  queued: number;
  /** Emails the conference turned off, or duplicates / invalid addresses left out. */
  skipped: number;
}

interface Template {
  label: string;
  subject: string;
  body: string;
}

/**
 * Queues emails: one or many in a single call. Each email is rendered now (template + values, in
 * the platform frame) and written to email_log as `queued` inside the caller's transaction, so it
 * is sent exactly when the change it reports is saved. The EmailWorker sends the queue in the
 * background, retrying failures.
 *
 * Templates: a conference's own copy (Conference Settings › Email Templates; `enabled: false` turns
 * that email off) wins over the platform default (Super Admin › Email Templates). Account emails
 * always use the platform default.
 */
@Injectable()
export class EmailQueueService {
  private readonly logoUrl: string | undefined;

  constructor(config: ConfigService<Env, true>) {
    this.logoUrl = emailLogoUrl(
      config.get('APP_URL', { infer: true }),
      config.get('EMAIL_LOGO_URL', { infer: true }),
    );
  }

  async enqueue(
    executor: Executor,
    event: string,
    emails: OutgoingEmail | readonly OutgoingEmail[],
    options: { sentBy?: string | null } = {},
  ): Promise<QueueResult> {
    const list = Array.isArray(emails) ? emails : [emails as OutgoingEmail];
    const templates = await this.loadTemplates(executor, list);
    const seen = new Set<string>();
    const rows: (typeof emailLog.$inferInsert)[] = [];
    let skipped = 0;

    for (const email of list) {
      const address = email.to.email.trim();
      const key = 'template' in email ? email.template : email.key;
      const dedupe = `${key}:${address.toLowerCase()}`;
      if (!VALID_EMAIL.test(address) || seen.has(dedupe)) {
        skipped += 1;
        continue;
      }
      seen.add(dedupe);

      let subject: string;
      let body: string;
      let label: string;
      if ('template' in email) {
        const template = templates.resolve(email.template, email.conference);
        if (!template) {
          skipped += 1; // turned off by the conference
          continue;
        }
        const values = {
          conference_name: email.conference?.title ?? '',
          conference_acronym: email.conference?.acronym ?? '',
          ...email.values,
        };
        subject = renderTemplate(template.subject, values, { html: false });
        body = renderTemplate(template.body, values, { html: true });
        label = template.label;
      } else {
        subject = email.subject;
        body = email.body;
        label = email.label;
      }

      rows.push({
        conferenceId: email.conference?.id ?? null,
        submissionId: email.submissionId ?? null,
        event,
        templateKey: key,
        templateLabel: label,
        toEmail: address,
        toName: email.to.name?.trim() || null,
        recipientType: email.recipientType ?? null,
        subject,
        body,
        html: frameEmail(body, {
          title: label,
          conferenceName: email.conference?.title,
          conferenceAcronym: email.conference?.acronym,
          logoUrl: this.logoUrl,
        }),
        text: `${htmlToText(body)}\n\n— The Smartconferu Team`,
        replyTo:
          email.conference?.contactEmail &&
          VALID_EMAIL.test(email.conference.contactEmail)
            ? email.conference.contactEmail
            : null,
        status: 'queued',
        sentBy: options.sentBy ?? null,
      });
    }

    if (rows.length > 0) {
      await executor.insert(emailLog).values(rows);
    }
    return { queued: rows.length, skipped };
  }

  /** The templates these emails need, read once: platform defaults and the conferences' copies. */
  private async loadTemplates(
    executor: Executor,
    emails: readonly OutgoingEmail[],
  ) {
    const templated = emails.filter((e): e is TemplateEmail => 'template' in e);
    const keys = [...new Set(templated.map((e) => e.template))];
    const platform = new Map<string, typeof emailTemplates.$inferSelect>();
    const own = new Map<string, typeof conferenceEmailTemplates.$inferSelect>();
    if (keys.length > 0) {
      for (const row of await executor
        .select()
        .from(emailTemplates)
        .where(inArray(emailTemplates.key, keys))) {
        platform.set(row.key, row);
      }
      const conferenceIds = [
        ...new Set(
          templated.flatMap((e) => (e.conference ? [e.conference.id] : [])),
        ),
      ];
      if (conferenceIds.length > 0) {
        for (const row of await executor
          .select()
          .from(conferenceEmailTemplates)
          .where(
            and(
              inArray(conferenceEmailTemplates.conferenceId, conferenceIds),
              inArray(conferenceEmailTemplates.key, keys),
            ),
          )) {
          own.set(`${row.conferenceId}:${row.key}`, row);
        }
      }
    }

    return {
      /** The template to send, or null when the conference turned it off. */
      resolve(
        key: string,
        conference: EmailConference | null | undefined,
      ): Template | null {
        const base = platform.get(key);
        if (!base) {
          throw new Error(`Unknown email template "${key}"`);
        }
        const copy =
          base.module === 'account' || !conference
            ? undefined
            : own.get(`${conference.id}:${key}`);
        if (copy && !copy.enabled) {
          return null;
        }
        return {
          label: copy?.label?.trim() || base.label,
          subject: copy?.subject.trim() ? copy.subject : base.subject,
          body: copy?.body.trim() ? copy.body : base.body,
        };
      },
    };
  }
}
