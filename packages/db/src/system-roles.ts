/**
 * Canonical definition of the per-tenant SYSTEM roles and their permission
 * scopes. Single source of truth shared by tenant provisioning (new tenants)
 * and the seed's repair pass (existing tenants) — a scope change here must
 * reach tenants that were provisioned before it, or old tenants silently keep
 * the wider grant (docs/07).
 */
export const SCOPES = {
  SELF: 'SELF',
  DIRECT_TEAM: 'DIRECT_TEAM',
  DESCENDANT_TEAMS: 'DESCENDANT_TEAMS',
  TENANT_ALL: 'TENANT_ALL',
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

export interface SystemRoleDef {
  code: string;
  name: string;
  /**
   * null = every TENANT-SCOPE permission in the catalog at TENANT_ALL.
   * Platform-scope keys are excluded — see `isTenantScopePermission`.
   */
  grants: Array<{ key: string; scope: Scope }> | null;
}

/**
 * `platform.*` keys govern the platform ACROSS tenants: creating tenants,
 * reading cross-tenant metrics. A tenant owner is the top of exactly one
 * tenant and must never hold them, or "grant every permission" quietly hands
 * one tenant's owner a view of everybody else's. Platform routes are gated on
 * platform ROLES, but a permission nobody should hold is a trap waiting for
 * the first route that checks the permission alone.
 */
export function isTenantScopePermission(key: string): boolean {
  return !key.startsWith('platform.');
}

export const SYSTEM_ROLES: SystemRoleDef[] = [
  { code: 'TENANT_OWNER', name: 'Tenant Owner', grants: null },
  {
    code: 'LEADER',
    name: 'Team Leader',
    grants: [
      { key: 'team.view', scope: SCOPES.DESCENDANT_TEAMS },
      { key: 'team.member.view', scope: SCOPES.DESCENDANT_TEAMS },
      { key: 'team.analytics.view', scope: SCOPES.DESCENDANT_TEAMS },
      // Publishing knowledge to the teams they lead, and everything beneath
      // (docs/37 §5). Reading team knowledge needs no grant at all — that is
      // membership, not leadership.
      { key: 'knowledge.team.manage', scope: SCOPES.DESCENDANT_TEAMS },
      { key: 'team.member.manage', scope: SCOPES.DIRECT_TEAM },
      { key: 'member.view', scope: SCOPES.DESCENDANT_TEAMS },
      // leaders coach their org's pipeline but do not own the records
      { key: 'crm.lead.view', scope: SCOPES.DESCENDANT_TEAMS },
      { key: 'crm.customer.view', scope: SCOPES.DESCENDANT_TEAMS },
      // The whole point of the Diamond sheet is a leader looking down a line,
      // so a leader reads their org's sheets — but ticks only their own, since
      // a step is a claim about work somebody actually did.
      { key: 'tracker.view', scope: SCOPES.DESCENDANT_TEAMS },
      { key: 'tracker.manage', scope: SCOPES.SELF },
      // A leader may ASK to view health data; the grant decides whether they
      // actually can. Deliberately not DESCENDANT_TEAMS — leadership confers
      // no health access on its own (spec §59).
      { key: 'health.coach.view', scope: SCOPES.SELF },
      { key: 'community.view', scope: SCOPES.DESCENDANT_TEAMS },
      { key: 'community.moderate', scope: SCOPES.DIRECT_TEAM },
      { key: 'commerce.catalog.view', scope: SCOPES.TENANT_ALL },
      { key: 'rank.view', scope: SCOPES.SELF },
      { key: 'referral.view', scope: SCOPES.SELF },
    ],
  },
  {
    code: 'MEMBER',
    name: 'Member',
    grants: [
      { key: 'goal.view', scope: SCOPES.SELF },
      { key: 'goal.manage', scope: SCOPES.SELF },
      { key: 'learning.view', scope: SCOPES.SELF },
      { key: 'ai.assistant.use', scope: SCOPES.SELF },
      { key: 'team.view', scope: SCOPES.DIRECT_TEAM },
      { key: 'notification.view', scope: SCOPES.SELF },
      // CRM is a member-level tool: each member works their own book.
      { key: 'crm.lead.view', scope: SCOPES.SELF },
      { key: 'tracker.view', scope: SCOPES.SELF },
      { key: 'tracker.manage', scope: SCOPES.SELF },
      { key: 'crm.lead.manage', scope: SCOPES.SELF },
      { key: 'crm.customer.view', scope: SCOPES.SELF },
      { key: 'crm.customer.manage', scope: SCOPES.SELF },
      // health data is SELF-scoped: the permission lets a member manage their
      // OWN record; seeing anyone else's needs that member's explicit grant.
      { key: 'health.profile.view', scope: SCOPES.SELF },
      { key: 'health.profile.edit', scope: SCOPES.SELF },
      // community and challenges are member-level participation
      { key: 'community.view', scope: SCOPES.DIRECT_TEAM },
      { key: 'community.post', scope: SCOPES.DIRECT_TEAM },
      { key: 'challenge.view', scope: SCOPES.SELF },
      { key: 'challenge.join', scope: SCOPES.SELF },
      // the catalogue is tenant-wide; what a member buys and subscribes to is
      // their own business, so orders and subscriptions stay SELF
      { key: 'commerce.catalog.view', scope: SCOPES.TENANT_ALL },
      { key: 'commerce.order.view', scope: SCOPES.SELF },
      { key: 'commerce.subscription.manage', scope: SCOPES.SELF },
      // growth: a member sees their own rank and who referred them
      { key: 'rank.view', scope: SCOPES.SELF },
      { key: 'referral.view', scope: SCOPES.SELF },
      { key: 'compensation.view', scope: SCOPES.SELF },
      { key: 'reward.view', scope: SCOPES.SELF },
      { key: 'analytics.self.view', scope: SCOPES.SELF },
    ],
  },
];
