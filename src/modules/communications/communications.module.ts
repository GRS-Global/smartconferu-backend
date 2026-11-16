import { Module } from '@nestjs/common';
import { SubmissionsModule } from '../submissions/submissions.module.js';
import {
  AdminEmailsController,
  ConferenceEmailsController,
} from './communications.controller.js';
import { CommunicationsService } from './communications.service.js';

/** Email Templates, Email Logs and the chair's own emails. */
@Module({
  imports: [SubmissionsModule],
  controllers: [ConferenceEmailsController, AdminEmailsController],
  providers: [CommunicationsService],
})
export class CommunicationsModule {}
