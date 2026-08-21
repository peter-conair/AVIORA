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
  /** Publishing knowledge to a team one leads (docs/37 §5). */
  KNOWLEDGE_TEAM_MANAGE: 'knowledge.team.manage',

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

  CRM_PIPELINE_MANAGE: 'crm.pipeline.manage',

  // community
  COMMUNITY_VIEW: 'community.view',
  COMMUNITY_POST: 'community.post',
  COMMUNITY_MODERATE: 'community.moderate',

  // challenges & gamification
  CHALLENGE_VIEW: 'challenge.view',
  CHALLENGE_JOIN: 'challenge.join',
  CHALLENGE_MANAGE: 'challenge.manage',
  GAMIFICATION_MANAGE: 'gamification.manage',

  // commerce (docs/16 Phase 2 — commerce supports the journey, spec §39/§40)
  COMMERCE_CATALOG_VIEW: 'commerce.catalog.view',
  COMMERCE_CATALOG_MANAGE: 'commerce.catalog.manage',
  COMMERCE_ORDER_VIEW: 'commerce.order.view',
  COMMERCE_ORDER_MANAGE: 'commerce.order.manage',
  COMMERCE_SUBSCRIPTION_MANAGE: 'commerce.subscription.manage',

  // growth: referral graph + ranks (docs/25, Phase 3 — optional layer)
  REFERRAL_VIEW: 'referral.view',
  REFERRAL_MANAGE: 'referral.manage',
  RANK_VIEW: 'rank.view',
  RANK_MANAGE: 'rank.manage',
  COMPENSATION_VIEW: 'compensation.view',
  COMPENSATION_MANAGE: 'compensation.manage',
  AUTOMATION_MANAGE: 'automation.manage',
  INTEGRATION_MANAGE: 'integration.manage',
  TENANT_SSO_MANAGE: 'tenant.sso.manage',
  ANALYTICS_SELF_VIEW: 'analytics.self.view',
  ANALYTICS_TENANT_VIEW: 'analytics.tenant.view',
  REWARD_VIEW: 'reward.view',
  REWARD_MANAGE: 'reward.manage',

  // notifications
  NOTIFICATION_VIEW: 'notification.view',

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
  /** A tenant that does not sell anything simply never grants this. */
  COMMERCE: 'commerce.enabled',
  /** Ranks and the referral graph are optional; most tenants never run them. */
  RANKS: 'growth.ranks',
  /** Compensation is optional by spec §42 and off unless a tenant configures it. */
  COMPENSATION: 'growth.compensation',
  /**
   * Browsing the multi-brand marketplace (spec §12's own example key, docs/44).
   * It gates the BROWSE surface, not the catalogue: a tenant without it still
   * sells, exactly as docs/24 §2 settled for commerce.
   */
  MARKETPLACE: 'marketplace.access',
} as const;

export type EntitlementKey = (typeof ENTITLEMENTS)[keyof typeof ENTITLEMENTS];
