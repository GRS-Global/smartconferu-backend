import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { EmailQueueService } from './email-queue.service.js';
import { EmailRecipientsService } from './email-recipients.service.js';
import { EmailWorker } from './email-worker.service.js';
import { EmailService } from './email.service.js';
import {
  EmailTransport,
  LogTransport,
  ResendTransport,
} from './email.transport.js';

/**
 * Email. Two ways to send:
 * - EmailService.send: right away, for account emails the user is waiting for (codes, links);
 * - EmailQueueService.enqueue: queued with the change it reports and sent by EmailWorker, for
 *   everything about conferences, papers and reviews (one email or thousands).
 */
@Global()
@Module({
  providers: [
    {
      provide: EmailTransport,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        config.get('EMAIL_TRANSPORT', { infer: true }) === 'resend'
          ? new ResendTransport(
              config.get('RESEND_API_KEY', { infer: true }) ?? '',
            )
          : new LogTransport(),
    },
    EmailService,
    EmailQueueService,
    EmailRecipientsService,
    EmailWorker,
  ],
  // EmailTransport and EmailWorker are exported so tests can read the outbox and send the queue.
  exports: [
    EmailService,
    EmailTransport,
    EmailQueueService,
    EmailRecipientsService,
    EmailWorker,
  ],
})
export class EmailModule {}
