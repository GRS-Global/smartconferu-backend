import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { type EmailMessage, EmailTransport } from './email.transport.js';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly from: string;

  constructor(
    private readonly transport: EmailTransport,
    config: ConfigService<Env, true>,
  ) {
    this.from = config.get('EMAIL_FROM', { infer: true });
  }

  /** Sends now; throws if the provider refuses it. */
  async send(message: EmailMessage): Promise<string | undefined> {
    return this.transport.send({ ...message, from: this.from });
  }

  /**
   * Sends without failing the caller: for emails the user can ask for again (verification links,
   * codes). Failures are logged.
   */
  async sendQuietly(message: EmailMessage): Promise<void> {
    try {
      await this.send(message);
    } catch (error) {
      this.logger.error(
        { err: error, subject: message.subject },
        'Email not sent',
      );
    }
  }
}
