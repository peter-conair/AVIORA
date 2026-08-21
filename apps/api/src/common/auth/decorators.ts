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

export const REQUIRE_PARTNER = 'requirePartner';
/**
 * Marks a route as PARTNER-facing (docs/46 §1).
 *
 * A partner is neither a platform role nor a member, and this is the only way
 * to reach a route as one: there is no configuration and no role that grants
 * it. The guard resolves the partner from the token's user inside the current
 * tenant and puts it in CLS — it never reads a partner id from the request, so
 * there is no id for a caller to change.
 *
 * Deliberately incompatible with `@RequirePermissions`: a route that was both
 * would be a route whose principal depends on who called it.
 */
export const RequirePartner = () => SetMetadata(REQUIRE_PARTNER, true);
