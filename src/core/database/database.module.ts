import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Env } from '../../config/env.js';
import { DatabaseService } from './database.service.js';
import { DRIZZLE, PG_CLIENT, schema } from './database.types.js';

@Global()
@Module({
  providers: [
    {
      provide: PG_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        postgres(config.get('DATABASE_URL', { infer: true }), {
          max: config.get('DATABASE_POOL_MAX', { infer: true }),
          onnotice: () => undefined,
        }),
    },
    {
      provide: DRIZZLE,
      inject: [PG_CLIENT],
      useFactory: (client: postgres.Sql) => drizzle({ client, schema }),
    },
    DatabaseService,
  ],
  exports: [DatabaseService, PG_CLIENT],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_CLIENT) private readonly client: postgres.Sql) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}
