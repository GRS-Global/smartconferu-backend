import { Module } from '@nestjs/common';
import { ActivityService } from './activity.service.js';
import { CfpsService } from './cfps.service.js';
import { ConferenceAdminController } from './conference-admin.controller.js';
import { ConferenceAdminService } from './conference-admin.service.js';
import { ConferenceEmailsService } from './conference-emails.service.js';
import { ConferencesController } from './conferences.controller.js';
import { ConferencesRepository } from './conferences.repository.js';
import { ConferencesService } from './conferences.service.js';
import { InvitationsController } from './invitations.controller.js';
import {
  AdminLicenseController,
  ConferenceLicenseController,
} from './license.controller.js';
import { LicenseService } from './license.service.js';
import { MembersRepository } from './members.repository.js';
import { MembersService } from './members.service.js';
import { PublicConferencesController } from './public-conferences.controller.js';

/** Conferences, their Call for Papers and their team. */
@Module({
  controllers: [
    ConferencesController,
    InvitationsController,
    PublicConferencesController,
    ConferenceAdminController,
    ConferenceLicenseController,
    AdminLicenseController,
  ],
  providers: [
    ConferenceEmailsService,
    ConferencesService,
    CfpsService,
    ActivityService,
    LicenseService,
    MembersService,
    ConferenceAdminService,
    ConferencesRepository,
    MembersRepository,
  ],
})
export class ConferencesModule {}
