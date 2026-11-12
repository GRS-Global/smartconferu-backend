import { Module } from '@nestjs/common';
import { CfpsService } from './cfps.service.js';
import { ConferenceAdminController } from './conference-admin.controller.js';
import { ConferenceAdminService } from './conference-admin.service.js';
import { ConferencesController } from './conferences.controller.js';
import { ConferencesRepository } from './conferences.repository.js';
import { ConferencesService } from './conferences.service.js';
import { InvitationsController } from './invitations.controller.js';
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
  ],
  providers: [
    ConferencesService,
    CfpsService,
    MembersService,
    ConferenceAdminService,
    ConferencesRepository,
    MembersRepository,
  ],
})
export class ConferencesModule {}
