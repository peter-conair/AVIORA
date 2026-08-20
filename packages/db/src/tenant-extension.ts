import { Prisma } from '@prisma/client';

/**
 * Prisma model names that are tenant-owned (must always be tenant-scoped).
 * Keep in sync with RLS policies in the migrations.
 */
export const TENANT_OWNED_MODELS = new Set<string>([
  'TenantSetting',
  'TenantMembership',
  'Member',
  'Role',
  'RolePermission',
  'MemberRole',
  'AuditLog',
  'MembershipPlan',
  'PlanEntitlement',
  'Membership',
  'Invitation',
  'Team',
  'TeamClosure',
  'TeamMembership',
  'TeamLeadership',
  'Goal',
  'Course',
  'Lesson',
  'LearningProgress',
  'PipelineStage',
  'Lead',
  'Customer',
  'FollowUp',
  'Interaction',
  'Notification',
  'NotificationPreference',
  // AI records are strictly tenant-owned. Knowledge tables are deliberately
  // absent: their rows may be GLOBAL (tenant_id NULL) and are gated by their
  // own layered RLS policy, so auto-injecting tenant_id would hide global
  // knowledge from every tenant.
  'AiConversation',
  'AiMessage',
  'AiUsage',
  'HealthProfile',
  'Habit',
  'HabitLog',
  'HealthMetric',
  'HealthDataGrant',
  'Community',
  'Post',
  'Comment',
  'Reaction',
  'Challenge',
  'ChallengeParticipant',
  'GamificationRule',
  'PointEntry',
  'MemberBadge',
  'Offering',
  'OfferingPlanPrice',
  'Coupon',
  'Cart',
  'CartItem',
  'Order',
  'OrderItem',
  'Payment',
  'Subscription',
  'SubscriptionRun',
  'ReferralRelationship',
  'RankDefinition',
  'RankQualification',
  'RankProgress',
  'RankHistory',
  'CompensationRelationship',
  'CompensationPlan',
  'CompensationRule',
  'CommissionRun',
  'CommissionEntry',
  'AutomationRule',
  'AutomationExecution',
  'RewardDefinition',
  'RewardGrant',
  'TenantBranding',
  'TenantLocalisation',
  'LegalDocument',
  'LegalAcceptance',
  'TaxRule',
]);

const LIST_OPS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
]);

/**
 * App-layer tenant guard (defense-in-depth layer 1; RLS is layer 2 — docs/03 §4).
 * - list/aggregate/bulk ops: AND-injects `tenantId` into `where`
 * - create/createMany: injects `tenantId` into `data`
 * - unique ops (findUnique/update/delete/upsert): left to the RLS backstop, which
 *   returns no row for foreign tenants when running inside `withTenant()`.
 */
/**
 * Stamps the scoped tenant onto a row. A row that already names a DIFFERENT
 * tenant is REFUSED rather than rewritten: quietly correcting it would hide the
 * bug (or the forged input) that produced it, and the caller would go on
 * believing it wrote where it asked to.
 */
function stamp(
  model: string,
  data: Record<string, unknown> | undefined,
  tenantId: string,
): Record<string, unknown> {
  const given = data?.['tenantId'];
  if (typeof given === 'string' && given !== tenantId) {
    throw new Error(
      `Cross-tenant write denied: ${model}.tenantId does not match the current tenant scope`,
    );
  }
  return { ...(data ?? {}), tenantId };
}

export function tenantExtension(getTenantId: () => string | null) {
  return Prisma.defineExtension({
    name: 'aviora-tenant-guard',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !TENANT_OWNED_MODELS.has(model)) return query(args);

          const tenantId = getTenantId();
          if (!tenantId) {
            throw new Error(
              `TenantContext missing: refusing ${operation} on tenant-owned model ${model}`,
            );
          }

          const a = (args ?? {}) as Record<string, unknown>;
          if (LIST_OPS.has(operation)) {
            a['where'] = { AND: [{ tenantId }, (a['where'] as object) ?? {}] };
          } else if (operation === 'create') {
            a['data'] = stamp(model, a['data'] as Record<string, unknown>, tenantId);
          } else if (operation === 'createMany') {
            const data = a['data'];
            if (Array.isArray(data)) {
              a['data'] = data.map((d: Record<string, unknown>) => stamp(model, d, tenantId));
            }
          }
          return query(a as never);
        },
      },
    },
  });
}
