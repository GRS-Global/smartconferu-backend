import { Injectable, Logger } from '@nestjs/common';

export interface EmailMessage {
  to: string;
  /** Shown as "Name <address>". */
  toName?: string | null;
  subject: string;
  html: string;
  text: string;
  /** Where replies go (a conference's contact address). */
  replyTo?: string | null;
  /** Files sent with the email. */
  attachments?: { filename: string; content: Buffer }[];
}

export interface SentEmail extends EmailMessage {
  from: string;
}

/** One message's outcome in a batch: the provider's id, or why it failed. */
export interface BatchResult {
  id?: string;
  error?: string;
}

/** Delivers emails; implementations are picked by EMAIL_TRANSPORT. */
export abstract class EmailTransport {
  /** Resolves to the provider's message id; throws if the provider refuses it. */
  abstract send(email: SentEmail): Promise<string | undefined>;

  /** Sends several; never throws. One result per email, in order. */
  async sendBatch(emails: SentEmail[]): Promise<BatchResult[]> {
    const results: BatchResult[] = [];
    for (const email of emails) {
      try {
        results.push({ id: await this.send(email) });
      } catch (error) {
        results.push({ error: errorMessage(error) });
      }
    }
    return results;
  }
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const recipient = (email: EmailMessage) =>
  email.toName
    ? `${email.toName.replace(/[<>",]/g, '').trim()} <${email.to}>`
    : email.to;

const RESEND_URL = 'https://api.resend.com';
/** Resend's limit for one batch request. */
const RESEND_BATCH_SIZE = 100;

/** Sends through Resend's HTTP API. */
export class ResendTransport extends EmailTransport {
  constructor(private readonly apiKey: string) {
    super();
  }

  private payload(email: SentEmail) {
    return {
      from: email.from,
      to: [recipient(email)],
      subject: email.subject,
      html: email.html,
      text: email.text,
      ...(email.replyTo ? { reply_to: email.replyTo } : {}),
      ...(email.attachments?.length
        ? {
            attachments: email.attachments.map((a) => ({
              filename: a.filename,
              content: a.content.toString('base64'),
            })),
          }
        : {}),
    };
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${RESEND_URL}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(
        `Resend responded ${response.status}: ${await response.text()}`,
      );
    }
    return response.json();
  }

  async send(email: SentEmail): Promise<string | undefined> {
    const json = (await this.post('/emails', this.payload(email))) as {
      id?: string;
    };
    return json.id;
  }

  /** Up to 100 emails per request (Resend's batch endpoint). The batch endpoint takes no attachments, so an email with files goes on its own. */
  override async sendBatch(emails: SentEmail[]): Promise<BatchResult[]> {
    const results: BatchResult[] = Array.from(
      { length: emails.length },
      () => ({}),
    );
    const plain: number[] = [];
    for (const [i, email] of emails.entries()) {
      if (!email.attachments?.length) {
        plain.push(i);
        continue;
      }
      try {
        results[i] = { id: await this.send(email) };
      } catch (error) {
        results[i] = { error: errorMessage(error) };
      }
    }
    for (let i = 0; i < plain.length; i += RESEND_BATCH_SIZE) {
      const idx = plain.slice(i, i + RESEND_BATCH_SIZE);
      const chunk = idx.map((k) => emails[k]);
      try {
        const json = (await this.post(
          '/emails/batch',
          chunk.map((email) => this.payload(email)),
        )) as { data?: { id?: string }[] };
        idx.forEach((k, j) => (results[k] = { id: json.data?.[j]?.id }));
      } catch (error) {
        const message = errorMessage(error);
        idx.forEach((k) => (results[k] = { error: message }));
      }
    }
    return results;
  }
}

/** Development and tests: logs the email and keeps it in `outbox` instead of sending it. */
@Injectable()
export class LogTransport extends EmailTransport {
  private readonly logger = new Logger('Email');
  readonly outbox: SentEmail[] = [];

  send(email: SentEmail): Promise<string | undefined> {
    this.outbox.push(email);
    const files = email.attachments?.length
      ? `\n[attached: ${email.attachments.map((a) => `${a.filename} (${a.content.length} bytes)`).join(', ')}]`
      : '';
    this.logger.log(
      `To ${recipient(email)}: ${email.subject}\n${email.text}${files}`,
    );
    return Promise.resolve(undefined);
  }
}
