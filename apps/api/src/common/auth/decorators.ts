import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';
/** Route requires no authentication. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const REQUIRED_PERMISSIONS = 'requiredPermissions';
/** Route requires ALL of these tenant permission keys (dot-notation). */
export const RequirePermissions = (...keys: string[]) => SetMetadata(REQUIRED_PERMISSIONS, keys);

export const REQUIRED_ENTITLEMENTS = 'requiredEntitlements';
/** Route requires ALL of these membership entitlement keys. */
export const RequireEntitlements = (...keys: string[]) => SetMetadata(REQUIRED_ENTITLEMENTS, keys);

export const REQUIRED_PLATFORM_ROLES = 'requiredPlatformRoles';
/** Route requires one of these platform roles (platform admin surface). */
export const RequirePlatformRoles = (...roles: string[]) =>
  SetMetadata(REQUIRED_PLATFORM_ROLES, roles);

export interface AuthenticatedUser {
  userId: string;
  email: string;
  platformRole: string | null;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser | undefined =>
    ctx.switchToHttp().getRequest().user,
);
