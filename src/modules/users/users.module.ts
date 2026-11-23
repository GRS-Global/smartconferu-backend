import { Module } from '@nestjs/common';
import { AccountLinkingService } from './account-linking.service.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { UsersController } from './users.controller.js';
import { UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [MasterDataModule],
  controllers: [UsersController],
  providers: [UsersService, UsersRepository, AccountLinkingService],
  exports: [AccountLinkingService],
})
export class UsersModule {}
