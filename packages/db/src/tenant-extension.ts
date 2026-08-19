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
            a['data'] = { ...(a['data'] as object), tenantId };
          } else if (operation === 'createMany') {
            const data = a['data'];
            if (Array.isArray(data)) {
              a['data'] = data.map((d: object) => ({ ...d, tenantId }));
            }
          }
          return query(a as never);
        },
      },
    },
  });
}
