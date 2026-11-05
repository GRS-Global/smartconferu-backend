import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException } from '../errors/app.exception.js';
import { AccessService } from './access.service.js';
import { CONF_ROLES, type MemberRole } from './conf-roles.decorator.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Global guard enforcing @ConfRoles(); runs after JwtAuthGuard. */
@Injectable()
export class ConferenceRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<MemberRole[] | undefined>(
      CONF_ROLES,
      [context.getHandler(), context.getClass()],
    );
    if (!roles) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const conferenceId = request.params.conferenceId;
    if (typeof conferenceId !== 'string') {
      throw new Error(
        `@ConfRoles() on ${context.getClass().name}.${context.getHandler().name} needs a :conferenceId route parameter`,
      );
    }
    if (!UUID.test(conferenceId)) {
      throw AppException.notFound('The conference');
    }
    if (!request.user) {
      throw AppException.forbidden();
    }
    await this.access.assertConfRole(request.user, conferenceId, roles);
    return true;
  }
}
