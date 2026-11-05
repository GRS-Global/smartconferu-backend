import { Global, Module } from '@nestjs/common';
import { AccessService } from './access.service.js';
import { ConferenceRoleGuard } from './conference-role.guard.js';
import { SuperAdminGuard } from './super-admin.guard.js';

@Global()
@Module({
  providers: [AccessService, ConferenceRoleGuard, SuperAdminGuard],
  exports: [AccessService, ConferenceRoleGuard, SuperAdminGuard],
})
export class RbacModule {}
