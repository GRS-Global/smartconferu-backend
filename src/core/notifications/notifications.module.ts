import { Global, Module } from '@nestjs/common';
import { LiveEventsService } from '../realtime/live-events.service.js';
import { NotificationsService } from './notifications.service.js';

/** The bell: notifications written with each change, and pushed live to open streams. */
@Global()
@Module({
  providers: [NotificationsService, LiveEventsService],
  exports: [NotificationsService, LiveEventsService],
})
export class NotificationsModule {}
