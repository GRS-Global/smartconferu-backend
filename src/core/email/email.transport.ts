import { Injectable, Logger } from '@nestjs/common';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SentEmail extends EmailMessage {
  from: string;
}

/** Delivers an email; implementations are picked by EMAIL_TRANSPORT. */
export abstract class EmailTransport {
  /** Resolves to the provider's message id. */
  abstract send(email: SentEmail): Promise<string | undefined>;
}

/** Sends through Resend's HTTP API. */
export class ResendTransport extends EmailTransport {
  constructor(private readonly apiKey: string) {
    super();
  }

  async send(email: SentEmail): Promise<string | undefined> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(email),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(
        `Resend responded ${response.status}: ${await response.text()}`,
      );
    }
    return ((await response.json()) as { id?: string }).id;
  }
}

/** Development and tests: logs the email and keeps it in `outbox` instead of sending it. */
@Injectable()
export class LogTransport extends EmailTransport {
  private readonly logger = new Logger('Email');
  readonly outbox: SentEmail[] = [];

  send(email: SentEmail): Promise<string | undefined> {
    this.outbox.push(email);
    this.logger.log(`To ${email.to}: ${email.subject}\n${email.text}`);
    return Promise.resolve(undefined);
  }
}
