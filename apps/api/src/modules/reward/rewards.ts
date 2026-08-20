import { z } from 'zod';

/**
 * Reward types (docs/27 §2). Spec §45: *"Separate reward from monetary
 * commission."* — so `cash` is on this list and is still only ever RECORDED.
 * Money moves through compensation, and even there through a payout provider
 * that does not exist yet.
 */
export const REWARD_TYPES = [
  'points',
  'badge',
  'course_access',
  'coupon',
  'membership_upgrade',
  'product',
  'event_ticket',
  'recognition',
  'certificate',
  'cash',
] as const;
export type RewardType = (typeof REWARD_TYPES)[number];

/** The types that DO something on the platform; the rest are recorded grants. */
export const FULFILLED_REWARD_TYPES = ['points', 'badge', 'course_access', 'coupon'] as const;

const pointsConfig = z.object({ points: z.number().int().positive().max(1_000_000) });

const badgeConfig = z.object({
  badgeCode: z.string().regex(/^[a-z0-9-]{2,40}$/),
  badgeName: z.string().min(1).max(80).optional(),
});

const courseAccessConfig = z.object({ courseId: z.string().uuid() });

const couponConfig = z.object({
  kind: z.enum(['percent', 'fixed']),
  /** percent: 1–100. fixed: minor units of `currency`. */
  value: z.number().int().positive(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  minSubtotalMinor: z.number().int().positive().max(1_000_000_000).optional(),
  expiresInDays: z.number().int().positive().max(3650).optional(),
});

export type CouponConfig = z.infer<typeof couponConfig>;

const CONFIG_SCHEMAS: Partial<Record<RewardType, z.ZodTypeAny>> = {
  points: pointsConfig,
  badge: badgeConfig,
  course_access: courseAccessConfig,
  coupon: couponConfig,
};

/**
 * A definition whose config cannot be fulfilled is a reward that fails on the
 * day somebody earns it — the one day nobody is watching a log. Checked at
 * creation instead, with the reason (docs/27 §1's rule for actions, applied to
 * the thing an action grants).
 */
export function configProblem(type: RewardType, config: unknown): string | null {
  const schema = CONFIG_SCHEMAS[type];
  if (!schema) return null; // recorded types carry whatever the tenant wants
  const result = schema.safeParse(config ?? {});
  if (result.success) return null;
  return result.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; ');
}

export function parseCouponConfig(config: unknown): CouponConfig {
  return couponConfig.parse(config ?? {});
}

export function parsePointsConfig(config: unknown): z.infer<typeof pointsConfig> {
  return pointsConfig.parse(config ?? {});
}

export function parseBadgeConfig(config: unknown): z.infer<typeof badgeConfig> {
  return badgeConfig.parse(config ?? {});
}

export function parseCourseAccessConfig(config: unknown): z.infer<typeof courseAccessConfig> {
  return courseAccessConfig.parse(config ?? {});
}

/**
 * What revoking DOES to a fulfilment that has already happened — which, for
 * every type, is nothing. A revoked grant is a record that the reward was taken
 * back, not an undo: points and badges belong to gamification and it has no
 * reversal path, and a coupon or a started course is the member's to keep.
 * Saying so on the grant is the alternative to leaving the two sides quietly
 * inconsistent (docs/27 §2).
 */
export function reversalNote(type: string): { reversed: false; note: string } {
  switch (type) {
    case 'points':
    case 'badge':
      return {
        reversed: false,
        note: 'Points and badges stay with the member: gamification has no reversal path, and deleting entries would erase the history a ledger exists to keep.',
      };
    case 'coupon':
      return {
        reversed: false,
        note: 'The issued coupon stays usable; withdrawing it is a commerce action on the coupon itself.',
      };
    case 'course_access':
      return {
        reversed: false,
        note: 'Learning progress is the member’s own and is not deleted; access already granted stays.',
      };
    default:
      return {
        reversed: false,
        note: 'Nothing was fulfilled on the platform — the grant was a record, and so is its revocation.',
      };
  }
}
