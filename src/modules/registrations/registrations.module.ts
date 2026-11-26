import { Module } from '@nestjs/common';
import { SubmissionsModule } from '../submissions/submissions.module.js';
import { ParticipantsController } from './participants.controller.js';
import { ParticipantsRepository } from './participants.repository.js';
import { ParticipantsService } from './participants.service.js';
import { RegistrationImportService } from './registration-import.service.js';

/** Participants of a conference and registration imports (payments of accepted papers live in submissions). */
@Module({
  imports: [SubmissionsModule],
  controllers: [ParticipantsController],
  providers: [
    ParticipantsRepository,
    ParticipantsService,
    RegistrationImportService,
  ],
})
export class RegistrationsModule {}
