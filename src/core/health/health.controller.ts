import { Controller, Get, HttpStatus } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/auth.decorators.js';
import { DatabaseService } from '../database/database.service.js';
import { AppException, ErrorCode } from '../errors/app.exception.js';

/** Probes for the load balancer: /health = the process is up, /health/ready = it can serve. */
@ApiTags('health')
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  @ApiOkResponse({ description: 'The process is running.' })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOkResponse({ description: 'The database is reachable.' })
  async ready(): Promise<{ status: 'ok' }> {
    try {
      await this.db.ping();
    } catch {
      throw new AppException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.NOT_READY,
        'The database is not reachable.',
      );
    }
    return { status: 'ok' };
  }
}
