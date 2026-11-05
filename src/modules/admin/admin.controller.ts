import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { SuperAdminOnly } from '../../core/rbac/super-admin.guard.js';

class AdminAccessResponse {
  @ApiProperty({ example: true })
  superAdmin: true;
}

/** The super-admin console. Every route here needs a super admin in a two-step-verified session. */
@ApiTags('admin')
@ApiBearerAuth()
@SuperAdminOnly()
@Controller('admin')
export class AdminController {
  @Get('access')
  @ApiOperation({
    summary:
      'Check admin access; 403 AUTH_MFA_SETUP_REQUIRED / AUTH_MFA_REQUIRED say what is missing',
  })
  @ApiOkResponse({ type: AdminAccessResponse })
  access(): AdminAccessResponse {
    return { superAdmin: true };
  }
}
