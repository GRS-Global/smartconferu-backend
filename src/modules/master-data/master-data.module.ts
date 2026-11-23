import { Module } from '@nestjs/common';
import {
  AdminMasterDataController,
  MasterDataController,
} from './master-data.controller.js';
import { MasterDataRepository } from './master-data.repository.js';
import { MasterDataService } from './master-data.service.js';
import { ProfileRequestsController } from './profile-requests.controller.js';
import { ProfileRequestsService } from './profile-requests.service.js';

/** Societies, institutions and research areas: read by everyone, kept by the Super Admin. */
@Module({
  controllers: [
    MasterDataController,
    AdminMasterDataController,
    ProfileRequestsController,
  ],
  providers: [MasterDataService, MasterDataRepository, ProfileRequestsService],
  exports: [ProfileRequestsService],
})
export class MasterDataModule {}
