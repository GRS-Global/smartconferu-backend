import { Module } from '@nestjs/common';
import { ScreeningNoticeService } from './screening-notice.service.js';
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
  controllers: [
    ConferenceSubmissionsController,
    ScreeningSettingsController,
    SubmissionsController,
  ],
  providers: [
    SubmissionsRepository,
    SubmissionsService,
    ScreeningService,
    ScreeningNoticeService,
    AutoInitialCheckService,
    SubmissionEmailsService,
    SubmissionFilesService,
  ],
})
export class SubmissionsModule {}
