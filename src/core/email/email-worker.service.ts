import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import type { Env } from '../../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { type EmailAttachment, emailLog } from '../database/schema/index.js';
import { FileStorage } from '../storage/file-storage.js';
import { EmailTransport, type SentEmail } from './email.transport.js';

/** Minutes to wait before attempt 2, 3, 4, 5. */
const RETRY_MINUTES = [1, 5, 30, 120];
/** An email stuck in `sending` this long (the process died mid-send) goes back to the queue. */
const STALE_SENDING_MINUTES = 10;
/** Attachments above this (all files of one email together) are left out: email services refuse large messages (Resend: 40 MB with encoding). */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

type Claimed = {
  id: string;
  to_email: string;
  to_name: string | null;
  subject: string;
  html: string | null;
  text: string | null;
  reply_to: string | null;
  attachments: EmailAttachment[] | null;
  attempts: number;
};

export interface DrainResult {
  sent: number;
  failed: number;
}

/**
 * Sends the email queue (email_log rows in `queued`). Runs in the API process every
 * EMAIL_QUEUE_INTERVAL_MS. Several API instances can run it at once: each claims its own rows
 * (`for update skip locked`). A failed email is retried later (1, 5, 30, 120 minutes) up to
 * EMAIL_MAX_ATTEMPTS, then marked `failed` with the reason, which chairs see in Email Logs.
 */
@Injectable()
export class EmailWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(EmailWorker.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly from: string;
  private timer?: NodeJS.Timeout;
  private running?: Promise<DrainResult>;

  constructor(
    private readonly database: DatabaseService,
    private readonly transport: EmailTransport,
    private readonly storage: FileStorage,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('EMAIL_QUEUE_ENABLED', { infer: true });
    this.intervalMs = config.get('EMAIL_QUEUE_INTERVAL_MS', { infer: true });
    this.batchSize = config.get('EMAIL_QUEUE_BATCH_SIZE', { infer: true });
    this.maxAttempts = config.get('EMAIL_MAX_ATTEMPTS', { infer: true });
    this.from = config.get('EMAIL_FROM', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      return;
    }
    this.timer = setInterval(() => {
      void this.drain().catch((error: unknown) =>
        this.logger.error({ err: error }, 'Email queue run failed'),
      );
    }, this.intervalMs);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }

  /**
   * Sends everything that is due, batch after batch, until the queue is empty. Concurrent calls
   * share one run.
   */
  drain(): Promise<DrainResult> {
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(): Promise<DrainResult> {
    const total: DrainResult = { sent: 0, failed: 0 };
    await this.requeueStale();
    for (;;) {
      const batch = await this.claim();
      if (batch.length === 0) {
        return total;
      }
      const result = await this.deliver(batch);
      total.sent += result.sent;
      total.failed += result.failed;
    }
  }

  private async requeueStale(): Promise<void> {
    await this.database.db.execute(sql`
      update ${emailLog} set status = 'queued', updated_at = now()
      where status = 'sending'
        and updated_at < now() - make_interval(mins => ${STALE_SENDING_MINUTES})`);
  }

  /** Takes up to a batch of due emails for this run (marks them `sending`). */
  private async claim(): Promise<Claimed[]> {
    const rows = await this.database.db.execute<Claimed>(sql`
      update ${emailLog}
         set status = 'sending', attempts = attempts + 1, updated_at = now()
       where id in (
         select id from ${emailLog}
          where status = 'queued' and coalesce(next_attempt_at, now()) <= now()
          order by next_attempt_at nulls first, created_at
          limit ${this.batchSize}
          for update skip locked)
      returning id, to_email, to_name, subject, html, text, reply_to, attachments, attempts`);
    return [...rows];
  }

  /** Reads an email's files from storage. A file that is gone, or too much in total, is left out (logged): the email still goes, and the
   *  file stays on the paper's page. */
  private async files(row: Claimed): Promise<SentEmail['attachments']> {
    if (!row.attachments?.length) return undefined;
    const out: { filename: string; content: Buffer }[] = [];
    let total = 0;
    for (const a of row.attachments) {
      try {
        const content = await this.storage.get(a.path);
        if (total + content.length > MAX_ATTACHMENT_BYTES) {
          this.logger.warn(
            { emailId: row.id, file: a.fileName },
            'Attachment left out: too large',
          );
          continue;
        }
        total += content.length;
        out.push({ filename: a.fileName, content });
      } catch (error) {
        this.logger.warn(
          { emailId: row.id, file: a.fileName, err: error },
          'Attachment left out: not found',
        );
      }
    }
    return out.length ? out : undefined;
  }

  private async deliver(batch: Claimed[]): Promise<DrainResult> {
    const emails: SentEmail[] = await Promise.all(
      batch.map(async (row) => ({
        from: this.from,
        to: row.to_email,
        toName: row.to_name,
        subject: row.subject,
        html: row.html ?? '',
        text: row.text ?? '',
        replyTo: row.reply_to,
        attachments: await this.files(row),
      })),
    );
    const results = await this.transport.sendBatch(emails);
    const result: DrainResult = { sent: 0, failed: 0 };

    for (const [i, row] of batch.entries()) {
      const outcome = results[i] ?? {
        error: 'No answer from the email service',
      };
      if (!outcome.error) {
        result.sent += 1;
        await this.database.db.execute(sql`
          update ${emailLog}
             set status = 'sent', provider_id = ${outcome.id ?? null}, error = null,
                 sent_at = now(), updated_at = now()
           where id = ${row.id}`);
        continue;
      }
      const final = row.attempts >= this.maxAttempts;
      const wait =
        RETRY_MINUTES[Math.min(row.attempts - 1, RETRY_MINUTES.length - 1)];
      if (final) {
        result.failed += 1;
        this.logger.warn(
          { emailId: row.id, error: outcome.error },
          'Email failed for good',
        );
      }
      await this.database.db.execute(sql`
        update ${emailLog}
           set status = ${final ? 'failed' : 'queued'}, error = ${outcome.error},
               next_attempt_at = now() + make_interval(mins => ${wait}), updated_at = now()
         where id = ${row.id}`);
    }
    return result;
  }
}
