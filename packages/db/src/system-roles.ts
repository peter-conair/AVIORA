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
  /** null = every permission in the catalog at TENANT_ALL (tenant owner). */
  grants: Array<{ key: string; scope: Scope }> | null;
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
      { key: 'team.member.manage', scope: SCOPES.DIRECT_TEAM },
      { key: 'member.view', scope: SCOPES.DESCENDANT_TEAMS },
      // leaders coach their org's pipeline but do not own the records
      { key: 'crm.lead.view', scope: SCOPES.DESCENDANT_TEAMS },
      { key: 'crm.customer.view', scope: SCOPES.DESCENDANT_TEAMS },
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
      { key: 'crm.lead.manage', scope: SCOPES.SELF },
      { key: 'crm.customer.view', scope: SCOPES.SELF },
      { key: 'crm.customer.manage', scope: SCOPES.SELF },
    ],
  },
];
