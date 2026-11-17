import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import { LoggerModule } from 'nestjs-pino';
import { type Env, validateEnv } from './config/env.js';
import { AuditModule } from './core/audit/audit.module.js';
import { AuthCoreModule } from './core/auth/auth.module.js';
import { JwtAuthGuard } from './core/auth/jwt-auth.guard.js';
import { DatabaseModule } from './core/database/database.module.js';
import { EmailModule } from './core/email/email.module.js';
import { AllExceptionsFilter } from './core/errors/all-exceptions.filter.js';
import { AppThrottlerGuard } from './core/http/app-throttler.guard.js';
import { HealthController } from './core/health/health.controller.js';
import { ConferenceRoleGuard } from './core/rbac/conference-role.guard.js';
import { NotificationsModule } from './core/notifications/notifications.module.js';
import { PlanModule } from './core/plan/plan.service.js';
import { StorageModule } from './core/storage/storage.module.js';
import { RbacModule } from './core/rbac/rbac.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { MasterDataModule } from './modules/master-data/master-data.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ConferencesModule } from './modules/conferences/conferences.module.js';
import { AiModule } from './modules/ai/ai.module.js';
import { CommunicationsModule } from './modules/communications/communications.module.js';
import { JobsModule } from './modules/jobs/jobs.module.js';
import { BellModule } from './modules/notifications/notifications.module.js';
import { ReviewsModule } from './modules/reviews/reviews.module.js';
import { SubmissionsModule } from './modules/submissions/submissions.module.js';
import { UsersModule } from './modules/users/users.module.js';

const REQUEST_ID = /^[\w.-]{1,128}$/;

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          // Reuse the load balancer's request id when it sends one, so logs line up end to end.
          genReqId: (req, res) => {
            const incoming = req.headers['x-request-id'];
            const id =
              typeof incoming === 'string' && REQUEST_ID.test(incoming)
                ? incoming
                : randomUUID();
            res.setHeader('x-request-id', id);
            return id;
          },
          customProps: (req) => ({ userId: (req as Request).user?.id }),
          // Keep request logs small and free of credentials.
          serializers: {
            req: (req: { id: unknown; method: string; url: string }) => ({
              id: req.id,
              method: req.method,
              url: req.url,
            }),
            res: (res: { statusCode: number }) => ({
              statusCode: res.statusCode,
            }),
          },
          redact: ['req.headers.authorization', 'req.headers.cookie'],
          autoLogging: {
            ignore: (req) => req.url?.startsWith('/health') ?? false,
          },
          transport:
            config.get('NODE_ENV', { infer: true }) === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        throttlers: [
          {
            ttl: 60_000,
            limit: config.get('RATE_LIMIT_PER_MINUTE', { infer: true }),
          },
        ],
      }),
    }),
    DatabaseModule,
    AuditModule,
    EmailModule,
    NotificationsModule,
    StorageModule,
    PlanModule,
    AuthCoreModule,
    RbacModule,
    AuthModule,
    UsersModule,
    ConferencesModule,
    SubmissionsModule,
    ReviewsModule,
    CommunicationsModule,
    BellModule,
    JobsModule,
    AiModule,
    AdminModule,
    MasterDataModule,
  ],
  controllers: [HealthController],
  providers: [
    // Guards run in this order: rate limit, then sign-in, then conference role.
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
    { provide: APP_GUARD, useExisting: ConferenceRoleGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
