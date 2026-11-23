import { Module } from '@nestjs/common';
import {
  AdminProfileVerificationController,
  MyProfileVerificationController,
} from './profile-verification.controller.js';
import { ProfileVerificationService } from './profile-verification.service.js';

/** "Verify my profile": the member's request and the Super Admin's decision. */
@Module({
  controllers: [
    MyProfileVerificationController,
    AdminProfileVerificationController,
  ],
  providers: [ProfileVerificationService],
})
export class ProfileVerificationModule {}
