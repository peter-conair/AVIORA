/**
 * TenantContext — carried through every request/job via AsyncLocalStorage (nestjs-cls).
 * All domain services receive this explicitly; CLS is transport, the parameter is the contract.
 * See docs/03-multi-tenant-architecture.md.
 */
export interface TenantContext {
  /** uuid of the resolved tenant; null for platform-scope requests (platform admin surface). */
  tenantId: string | null;
  /** How the tenant was resolved — used for audit + mismatch detection. */
  source: 'subdomain' | 'custom-domain' | 'header' | 'jwt' | 'platform' | 'system';
  /** Authenticated global user id (null for anonymous endpoints). */
  userId: string | null;
  /** Member id inside the resolved tenant (null when user is not a member of it). */
  memberId: string | null;
  /** Correlation id for logs/audit. */
  requestId: string;
}

export interface PlatformActor {
  userId: string;
  requestId: string;
}
