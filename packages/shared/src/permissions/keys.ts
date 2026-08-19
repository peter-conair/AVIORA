/**
 * Permission catalog — dot-notation keys (docs/07-role-permission-matrix.md).
 * Never branch on role or plan names; always check permission keys + scope.
 */
export enum PermissionScope {
  SELF = 'SELF',
  DIRECT_TEAM = 'DIRECT_TEAM',
  DESCENDANT_TEAMS = 'DESCENDANT_TEAMS',
  SPECIFIC_TEAMS = 'SPECIFIC_TEAMS',
  TENANT_ALL = 'TENANT_ALL',
}

export const PERMISSIONS = {
  // tenant administration
  TENANT_SETTINGS_VIEW: 'tenant.settings.view',
  TENANT_SETTINGS_MANAGE: 'tenant.settings.manage',
  TENANT_ROLE_MANAGE: 'tenant.role.manage',

  // members
  MEMBER_VIEW: 'member.view',
  MEMBER_MANAGE: 'member.manage',
  MEMBER_INVITE: 'member.invite',

  // membership plans
  MEMBERSHIP_PLAN_VIEW: 'membership.plan.view',
  MEMBERSHIP_PLAN_MANAGE: 'membership.plan.manage',
  MEMBERSHIP_ASSIGN: 'membership.assign',

  // teams
  TEAM_VIEW: 'team.view',
  TEAM_CREATE: 'team.create',
  TEAM_MANAGE: 'team.manage',
  TEAM_MEMBER_VIEW: 'team.member.view',
  TEAM_MEMBER_MANAGE: 'team.member.manage',
  TEAM_LEADER_ASSIGN: 'team.leader.assign',
  TEAM_ANALYTICS_VIEW: 'team.analytics.view',

  // goals
  GOAL_VIEW: 'goal.view',
  GOAL_MANAGE: 'goal.manage',

  // learning
  LEARNING_VIEW: 'learning.view',
  LEARNING_MANAGE: 'learning.manage',
  LEARNING_ASSIGN: 'learning.assign',

  // crm
  CRM_LEAD_VIEW: 'crm.lead.view',
  CRM_LEAD_MANAGE: 'crm.lead.manage',
  CRM_CUSTOMER_VIEW: 'crm.customer.view',
  CRM_CUSTOMER_MANAGE: 'crm.customer.manage',

  // ai
  AI_ASSISTANT_USE: 'ai.assistant.use',

  // audit
  AUDIT_VIEW: 'audit.view',

  // health (reserved — Phase 2; consent-gated, see docs/13 §health)
  HEALTH_PROFILE_VIEW: 'health.profile.view',
  HEALTH_PROFILE_EDIT: 'health.profile.edit',
  HEALTH_COACH_VIEW: 'health.coach.view',

  // platform scope (platform roles only)
  PLATFORM_TENANT_MANAGE: 'platform.tenant.manage',
  PLATFORM_METRICS_VIEW: 'platform.metrics.view',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Entitlement catalog — capability keys granted through membership plans (docs/04). */
export const ENTITLEMENTS = {
  COURSE_ACCESS: 'course.access',
  AI_COACH: 'ai.coach',
  COMMUNITY_PRIVATE: 'community.private',
  BUSINESS_CRM: 'business.crm',
  TEAM_CREATE: 'team.create',
  TEAM_MANAGE: 'team.manage',
  ANALYTICS_TEAM: 'analytics.team',
  MENTOR_ACCESS: 'mentor.access',
} as const;

export type EntitlementKey = (typeof ENTITLEMENTS)[keyof typeof ENTITLEMENTS];
