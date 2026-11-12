import { SetMetadata } from '@nestjs/common';
import type { MemberRole } from './access-rules.js';

export type { MemberRole };

export const CONF_ROLES = 'rbac:confRoles';

/**
 * Limits a route to members with one of these roles on the conference in the `:conferenceId`
 * route parameter. Super admins always pass. For routes addressed by another id (a submission, a
 * review), check access in the service with AccessService instead.
 */
export const ConfRoles = (...roles: [MemberRole, ...MemberRole[]]) =>
  SetMetadata(CONF_ROLES, roles);
