import { Module } from '@nestjs/common';
import { LiveEventsController } from './live-events.controller.js';
import {
  BellService,
  MyEmailsController,
  NotificationsController,
} from './notifications.controller.js';

/** The bell: reading and marking one's own notifications, and the live-event stream. (Writing them: core/notifications.) */
@Module({
  controllers: [
    NotificationsController,
    MyEmailsController,
    LiveEventsController,
  ],
  providers: [BellService],
})
export class BellModule {}
