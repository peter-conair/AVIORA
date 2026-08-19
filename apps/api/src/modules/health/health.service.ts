import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ERROR_CODES, EVENTS } from '@aviora/shared';
import { appendEvent } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { HealthAccessService } from './health-access.service';

const WINDOW_DAYS = 30;

/**
 * The safety note is the most important sentence in this domain, so it is
 * localised like any other member-facing text — an English disclaimer on a Thai
 * screen is the one place a fallback is not good enough.
 */
const SAFETY_NOTE: Record<string, string> = {
  en: 'This is a record of what you logged, not a health assessment. Talk to a qualified healthcare professional about your health.',
  th: 'นี่คือบันทึกสิ่งที่คุณกรอกไว้ ไม่ใช่การประเมินสุขภาพ กรุณาปรึกษาบุคลากรทางการแพทย์เกี่ยวกับสุขภาพของคุณ',
};

/** Metrics a member may record. Deliberately observational — no diagnoses. */
export const TRACKED_METRICS = ['weight_kg', 'sleep_hours', 'water_ml', 'steps'] as const;

@Injectable()
export class HealthService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly access: HealthAccessService,
    private readonly crypto: FieldEncryptionService,
  ) {}

  private requireMember(memberId: string | null): string {
    if (!memberId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    return memberId;
  }

  // ── profile ─────────────────────────────────────────────────────────────

  async profile(actorMemberId: string | null, subjectMemberId: string) {
    return this.db.tx(async (tx) => {
      await this.access.assertCanView(tx, actorMemberId, subjectMemberId);
      const row = await tx.healthProfile.findFirst({ where: { memberId: subjectMemberId } });
      if (!row) return null;
      return {
        memberId: row.memberId,
        // notes are encrypted at rest; only the reader who passed the access
        // check above ever sees the plaintext
        lifestyleNotes: this.crypto.decrypt(row.lifestyleNotes),
        focusGoalIds: (row.focusGoalIds as string[]) ?? [],
        updatedAt: row.updatedAt,
      };
    });
  }

  async saveProfile(
    actorMemberId: string | null,
    input: { lifestyleNotes?: string; focusGoalIds?: string[] },
  ) {
    const memberId = this.requireMember(actorMemberId);
    const encrypted =
      input.lifestyleNotes === undefined ? undefined : this.crypto.encrypt(input.lifestyleNotes);

    const saved = await this.db.tx(async (tx) => {
      const existing = await tx.healthProfile.findFirst({ where: { memberId } });
      if (existing) {
        return tx.healthProfile.update({
          where: { id: existing.id },
          data: {
            ...(encrypted !== undefined ? { lifestyleNotes: encrypted } : {}),
            ...(input.focusGoalIds ? { focusGoalIds: input.focusGoalIds } : {}),
          },
        });
      }
      return tx.healthProfile.create({
        data: {
          tenantId: this.db.tenantId,
          memberId,
          lifestyleNotes: encrypted ?? null,
          focusGoalIds: input.focusGoalIds ?? [],
        },
      });
    });
    // the audit trail records THAT health data changed, never its contents
    await this.audit.record({
      action: 'health.profile.update',
      entityType: 'health_profile',
      entityId: saved.id,
      after: { focusGoalCount: (input.focusGoalIds ?? []).length },
    });
    return this.profile(memberId, memberId);
  }

  // ── habits ──────────────────────────────────────────────────────────────

  habits(actorMemberId: string | null, subjectMemberId: string) {
    return this.db.tx(async (tx) => {
      await this.access.assertCanView(tx, actorMemberId, subjectMemberId);
      return tx.habit.findMany({
        where: { memberId: subjectMemberId, status: 'active' },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
          cadence: true,
          targetUnit: true,
          targetValue: true,
        },
      });
    });
  }

  async createHabit(
    actorMemberId: string | null,
    input: {
      code: string;
      name: string;
      cadence?: string;
      targetUnit?: string;
      targetValue?: number;
    },
  ) {
    const memberId = this.requireMember(actorMemberId);
    return this.db.tx(async (tx) => {
      const dup = await tx.habit.findFirst({ where: { memberId, code: input.code } });
      if (dup) {
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'You already have a habit with this code',
        });
      }
      return tx.habit.create({
        data: {
          tenantId: this.db.tenantId,
          memberId,
          code: input.code,
          name: input.name,
          cadence: input.cadence ?? 'daily',
          targetUnit: input.targetUnit,
          targetValue: input.targetValue,
        },
      });
    });
  }

  /** Logging is idempotent per habit per day — re-logging updates the value. */
  async logHabit(
    actorMemberId: string | null,
    habitId: string,
    input: { logDate?: Date; value?: number; completed?: boolean },
  ) {
    const memberId = this.requireMember(actorMemberId);
    const logDate = startOfDay(input.logDate ?? new Date());
    return this.db.tx(async (tx) => {
      const habit = await tx.habit.findFirst({ where: { id: habitId } });
      if (!habit) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Habit not found' });
      }
      this.access.assertCanEdit(memberId, habit.memberId);
      const existing = await tx.habitLog.findFirst({ where: { habitId, logDate } });
      if (existing) {
        return tx.habitLog.update({
          where: { id: existing.id },
          data: { value: input.value, completed: input.completed ?? true },
        });
      }
      const created = await tx.habitLog.create({
        data: {
          tenantId: this.db.tenantId,
          habitId,
          memberId,
          logDate,
          value: input.value,
          completed: input.completed ?? true,
        },
      });
      // The event says a habit was logged; it deliberately carries no value,
      // no habit name and no metric, so subscribers (points, challenges) never
      // receive health content (spec §59).
      await appendEvent(tx, {
        eventName: EVENTS.HabitLogged,
        tenantId: this.db.tenantId,
        aggregateType: 'habit',
        aggregateId: habitId,
        actorUserId: null,
        payload: { memberId, logDate: logDate.toISOString().slice(0, 10) },
      });
      return created;
    });
  }

  // ── metrics ─────────────────────────────────────────────────────────────

  async recordMetric(
    actorMemberId: string | null,
    input: { metric: string; value: number; unit: string; measuredOn?: Date },
  ) {
    const memberId = this.requireMember(actorMemberId);
    const measuredOn = startOfDay(input.measuredOn ?? new Date());
    return this.db.tx(async (tx) => {
      const existing = await tx.healthMetric.findFirst({
        where: { memberId, metric: input.metric, measuredOn },
      });
      if (existing) {
        return tx.healthMetric.update({
          where: { id: existing.id },
          data: { value: input.value, unit: input.unit },
        });
      }
      return tx.healthMetric.create({
        data: {
          tenantId: this.db.tenantId,
          memberId,
          metric: input.metric,
          value: input.value,
          unit: input.unit,
          measuredOn,
        },
      });
    });
  }

  /**
   * A member's healthy-living summary: habit consistency over the window and
   * the latest reading per metric. Deliberately descriptive — it reports what
   * the member recorded and never scores, rates, or interprets their health.
   */
  async summary(actorMemberId: string | null, subjectMemberId: string, locale = 'en') {
    return this.db.tx(async (tx) => {
      await this.access.assertCanView(tx, actorMemberId, subjectMemberId);
      const since = startOfDay(new Date(Date.now() - WINDOW_DAYS * 86_400_000));

      const [habits, logs, metrics] = await Promise.all([
        tx.habit.findMany({
          where: { memberId: subjectMemberId, status: 'active' },
          select: { id: true, code: true, name: true, cadence: true, targetUnit: true },
        }),
        tx.habitLog.findMany({
          where: { memberId: subjectMemberId, logDate: { gte: since }, completed: true },
          select: { habitId: true, logDate: true },
        }),
        tx.healthMetric.findMany({
          where: { memberId: subjectMemberId, measuredOn: { gte: since } },
          orderBy: { measuredOn: 'desc' },
          select: { metric: true, value: true, unit: true, measuredOn: true },
        }),
      ]);

      const daysByHabit = new Map<string, Set<string>>();
      for (const log of logs) {
        const key = log.logDate.toISOString().slice(0, 10);
        const set = daysByHabit.get(log.habitId) ?? new Set<string>();
        set.add(key);
        daysByHabit.set(log.habitId, set);
      }

      const latestByMetric = new Map<string, (typeof metrics)[number]>();
      for (const m of metrics) {
        if (!latestByMetric.has(m.metric)) latestByMetric.set(m.metric, m);
      }

      return {
        memberId: subjectMemberId,
        windowDays: WINDOW_DAYS,
        habits: habits.map((h) => ({
          ...h,
          daysLogged: daysByHabit.get(h.id)?.size ?? 0,
        })),
        latestMetrics: [...latestByMetric.values()].map((m) => ({
          metric: m.metric,
          value: Number(m.value),
          unit: m.unit,
          measuredOn: m.measuredOn,
        })),
        note: SAFETY_NOTE[locale] ?? SAFETY_NOTE.en!,
      };
    });
  }

  // ── consent ─────────────────────────────────────────────────────────────

  grants(actorMemberId: string | null) {
    const memberId = this.requireMember(actorMemberId);
    return this.db.tx(async (tx) => {
      const [given, received] = await Promise.all([
        tx.healthDataGrant.findMany({
          where: { memberId, revokedAt: null },
          select: { id: true, granteeMemberId: true, scope: true, grantedAt: true },
        }),
        tx.healthDataGrant.findMany({
          where: { granteeMemberId: memberId, revokedAt: null },
          select: { id: true, memberId: true, scope: true, grantedAt: true },
        }),
      ]);
      return { given, received };
    });
  }

  async grantAccess(actorMemberId: string | null, granteeMemberId: string) {
    const memberId = this.requireMember(actorMemberId);
    if (memberId === granteeMemberId) {
      throw new ConflictException({
        code: ERROR_CODES.CONFLICT,
        message: 'You already have access to your own health data',
      });
    }
    const grant = await this.db.tx(async (tx) => {
      const grantee = await tx.member.findFirst({ where: { id: granteeMemberId } });
      if (!grantee) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Member not found' });
      }
      const existing = await tx.healthDataGrant.findFirst({
        where: { memberId, granteeMemberId },
      });
      if (existing) {
        return tx.healthDataGrant.update({
          where: { id: existing.id },
          data: { revokedAt: null, grantedAt: new Date() },
        });
      }
      return tx.healthDataGrant.create({
        data: { tenantId: this.db.tenantId, memberId, granteeMemberId },
      });
    });
    await this.audit.record({
      action: 'health.grant.create',
      entityType: 'health_data_grant',
      entityId: grant.id,
      after: { granteeMemberId },
    });
    return grant;
  }

  async revokeAccess(actorMemberId: string | null, granteeMemberId: string) {
    const memberId = this.requireMember(actorMemberId);
    const revoked = await this.db.tx(async (tx) => {
      const existing = await tx.healthDataGrant.findFirst({
        where: { memberId, granteeMemberId, revokedAt: null },
      });
      if (!existing) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Grant not found' });
      }
      return tx.healthDataGrant.update({
        where: { id: existing.id },
        data: { revokedAt: new Date() },
      });
    });
    await this.audit.record({
      action: 'health.grant.revoke',
      entityType: 'health_data_grant',
      entityId: revoked.id,
      after: { granteeMemberId },
    });
    return revoked;
  }
}

/** Dates are stored as `date` columns; normalise to UTC midnight. */
function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
