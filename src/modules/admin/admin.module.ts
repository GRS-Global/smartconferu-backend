import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { AdminQueueController } from './admin-queue.controller.js';
import { AdminQueueService } from './admin-queue.service.js';
import { AdminUsersController } from './admin-users.controller.js';
import { AdminUsersService } from './admin-users.service.js';

/** The super-admin console (conference and deletion requests live in the conferences module). */
@Module({
  controllers: [AdminController, AdminQueueController, AdminUsersController],
  providers: [AdminService, AdminQueueService, AdminUsersService],
})
export class AdminModule {}
