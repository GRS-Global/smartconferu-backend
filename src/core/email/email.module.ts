import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { EmailService } from './email.service.js';
import {
  EmailTransport,
  LogTransport,
  ResendTransport,
} from './email.transport.js';

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
  ],
  // EmailTransport is exported so tests can read the LogTransport outbox.
  exports: [EmailService, EmailTransport],
})
export class EmailModule {}
