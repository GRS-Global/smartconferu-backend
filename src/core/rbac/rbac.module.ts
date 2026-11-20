import { Global, Module } from '@nestjs/common';
import { AccessService } from './access.service.js';
import { ConferenceRoleGuard } from './conference-role.guard.js';
import { StepUpGuard } from './step-up.guard.js';
import { SuperAdminGuard } from './super-admin.guard.js';
import { SupportViewGuard } from './support-view.guard.js';
import { SuspensionGuard } from './suspension.guard.js';

@Global()
@Module({
  providers: [
    AccessService,
    ConferenceRoleGuard,
    SuperAdminGuard,
    StepUpGuard,
    SuspensionGuard,
    SupportViewGuard,
  ],
  exports: [
    AccessService,
    ConferenceRoleGuard,
    SuperAdminGuard,
    StepUpGuard,
    SuspensionGuard,
    SupportViewGuard,
  ],
})
export class RbacModule {}
