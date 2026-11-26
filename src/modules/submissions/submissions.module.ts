import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { ScreeningNoticeService } from './screening-notice.service.js';
import { PaymentReceiptsService } from './payment-receipts.service.js';
import { RegistrationService } from './registration.service.js';
import { ScreeningService } from './screening.service.js';
import { AutoInitialCheckService } from './screening/auto-initial-check.service.js';
import { SubmissionEmailsService } from './submission-emails.service.js';
import { SubmissionFilesService } from './submission-files.service.js';
import {
  ConferenceSubmissionsController,
  ScreeningSettingsController,
  SubmissionsController,
} from './submissions.controller.js';
import { SubmissionsRepository } from './submissions.repository.js';
import { SubmissionsService } from './submissions.service.js';

@Module({
  imports: [AiModule],
  controllers: [
    ConferenceSubmissionsController,
    ScreeningSettingsController,
    SubmissionsController,
  ],
  providers: [
    SubmissionsRepository,
    SubmissionsService,
    ScreeningService,
    RegistrationService,
    PaymentReceiptsService,
    ScreeningNoticeService,
    AutoInitialCheckService,
    SubmissionEmailsService,
    SubmissionFilesService,
  ],
  // The reviews module builds on the paper page, its context and its author emails.
  exports: [
    SubmissionsRepository,
    SubmissionsService,
    SubmissionEmailsService,
    ScreeningService,
    PaymentReceiptsService,
  ],
})
export class SubmissionsModule {}
