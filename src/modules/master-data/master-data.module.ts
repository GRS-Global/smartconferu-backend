import { Module } from '@nestjs/common';
import {
  AdminMasterDataController,
  MasterDataController,
} from './master-data.controller.js';
import { MasterDataRepository } from './master-data.repository.js';
import { MasterDataService } from './master-data.service.js';

/** Societies, institutions and research areas: read by everyone, kept by the Super Admin. */
@Module({
  controllers: [MasterDataController, AdminMasterDataController],
  providers: [MasterDataService, MasterDataRepository],
})
export class MasterDataModule {}
