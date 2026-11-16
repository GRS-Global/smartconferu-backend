import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

/** The super-admin console (conference and deletion requests live in the conferences module). */
@Module({ controllers: [AdminController], providers: [AdminService] })
export class AdminModule {}
