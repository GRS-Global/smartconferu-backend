import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import type { Request } from 'express';
import { AppException } from '../errors/app.exception.js';
import { AccessService } from './access.service.js';

export const SUPER_ADMIN_ONLY = 'rbac:superAdminOnly';

@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(private readonly access: AccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest<Request>().user;
    if (!user) {
      throw AppException.forbidden();
    }
    await this.access.assertSuperAdmin(user);
    return true;
  }
}

/** Limits a route or controller to super admins in a two-step-verified session. */
export const SuperAdminOnly = () =>
  applyDecorators(
    SetMetadata(SUPER_ADMIN_ONLY, true),
    UseGuards(SuperAdminGuard),
  );
