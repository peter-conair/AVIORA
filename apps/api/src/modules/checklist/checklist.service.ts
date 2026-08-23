import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CHECKLIST_SEEDS,
  DAILY_CHECKLIST,
  ERROR_CODES,
  PERMISSIONS,
  WEEKLY_CHECKLIST,
  startOfWeekUtc,
} from '@aviora/shared';
import type { Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import type { TeamActor } from '../team/team-scope.service';
import { CrmScopeService } from '../crm/crm-scope.service';

type Locale = 'en' | 'th';

/**
 * DAILY CHECK LIST (docs/60).
 *
 * Runs on the habits engine from Sprint 6 rather than a new grid — these are
 * recurring ticks with a date, which is what that engine already stores.
 *
 * The one thing that is NOT reused is the privacy model. Health habits carry
 * docs/13's promise that nobody sees a member's logs without a grant, not even
 * their leader. Business habits are the opposite: a coach seeing whether the
 * calls were made is the entire point of the sheet. Every query here filters
 * `category: 'business'` explicitly, and a test proves a coach reading a
 * downline's checklist gets no health row even with no grant in place.
 */
@Injectable()
export class ChecklistService {
  constructor(
    private readonly db: TenantDb,
    private readonly scope: CrmScopeService,
  ) {}

  private requireMember(actor: TeamActor): string {
    if (!actor.memberId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    return actor.memberId;
  }

  /**
   * The sixteen habits, created on first read.
   *
   * Only into a member who has none, for the same reason the tracker seeds that
   * way: somebody who deleted an item they do not do should not find it back.
   */
  private async ensureHabits(tx: Tx, memberId: string, locale: Locale) {
    const existing = await tx.habit.findMany({
      where: { memberId, category: 'business' },
      select: { code: true },
    });
    if (existing.length > 0) return;
    await tx.habit.createMany({
      data: CHECKLIST_SEEDS.map((seed) => ({
        tenantId: this.db.tenantId,
        memberId,
        code: seed.code,
        name: seed.label[locale],
        category: 'business',
        cadence: seed.cadence,
      })),
    });
  }

  /**
   * A weekly habit is logged against the week, not the day.
   *
   * `cadence: 'weekly'` has been accepted and stored since Sprint 6 and nothing
   * ever read it, so a weekly item ticked on Wednesday and again on Thursday
   * made two logs and "weekly" meant nothing (docs/60 §2). Normalising here is
   * what makes `UNIQUE (habit_id, log_date)` enforce once a week.
   */
  static logDateFor(cadence: string, date: Date): Date {
    const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    return cadence === 'weekly' ? startOfWeekUtc(day) : day;
  }

  private async readableMember(tx: Tx, actor: TeamActor, memberId?: string): Promise<string> {
    const self = this.requireMember(actor);
    if (!memberId || memberId === self) return self;
    const owners = await this.scope.ownerMemberIds(tx, actor, PERMISSIONS.TRACKER_VIEW);
    if (!this.scope.canAccess(owners, memberId)) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'That member is outside your scope',
      });
    }
    return memberId;
  }

  /** One week of the sheet: seven days of daily items plus the weekly column. */
  async week(
    actor: TeamActor,
    weekOf: string | undefined,
    memberId: string | undefined,
    locale: Locale,
  ) {
    const requested = weekOf ? new Date(`${weekOf}T00:00:00Z`) : new Date();
    const weekStart = startOfWeekUtc(Number.isNaN(requested.getTime()) ? new Date() : requested);
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

    return this.db.tx(async (tx) => {
      const subject = await this.readableMember(tx, actor, memberId);
      await this.ensureHabits(tx, subject, locale);

      const habits = await tx.habit.findMany({
        // The filter that keeps a health row out of a coach's view. Not a
        // convention — the whole privacy boundary rests on it.
        where: { memberId: subject, category: 'business', status: 'active' },
        select: { id: true, code: true, name: true, cadence: true },
      });
      const logs = await tx.habitLog.findMany({
        where: {
          memberId: subject,
          habitId: { in: habits.map((h) => h.id) },
          logDate: { gte: weekStart, lt: weekEnd },
          completed: true,
        },
        select: { habitId: true, logDate: true },
      });
      const doneOn = new Set(
        logs.map((l) => `${l.habitId}|${l.logDate.toISOString().slice(0, 10)}`),
      );

      const days = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(weekStart);
        d.setUTCDate(d.getUTCDate() + i);
        return d.toISOString().slice(0, 10);
      });
      const order = new Map(CHECKLIST_SEEDS.map((s, i) => [s.code, i]));
      const sorted = [...habits].sort(
        (a, b) => (order.get(a.code) ?? 99) - (order.get(b.code) ?? 99),
      );

      return {
        weekOf: weekStart.toISOString().slice(0, 10),
        memberId: subject,
        isSelf: subject === actor.memberId,
        days,
        daily: sorted
          .filter((h) => h.cadence === 'daily')
          .map((h) => ({
            id: h.id,
            code: h.code,
            name: h.name,
            done: days.filter((d) => doneOn.has(`${h.id}|${d}`)),
          })),
        weekly: sorted
          .filter((h) => h.cadence === 'weekly')
          .map((h) => ({
            id: h.id,
            code: h.code,
            name: h.name,
            // A weekly item is one tick for the whole week, keyed on the
            // week's own start date.
            done: doneOn.has(`${h.id}|${weekStart.toISOString().slice(0, 10)}`),
          })),
        expectedDaily: DAILY_CHECKLIST.length,
        expectedWeekly: WEEKLY_CHECKLIST.length,
      };
    });
  }

  /** Tick or un-tick one box. Only ever your own — a tick claims you did it. */
  async setLog(actor: TeamActor, habitId: string, dateInput: string | undefined, done: boolean) {
    const memberId = this.requireMember(actor);
    return this.db.tx(async (tx) => {
      const habit = await tx.habit.findFirst({ where: { id: habitId, category: 'business' } });
      if (!habit) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Item not found' });
      }
      if (habit.memberId !== memberId) {
        throw new ForbiddenException({
          code: ERROR_CODES.FORBIDDEN,
          message: 'You can only tick your own checklist',
        });
      }
      const asked = dateInput ? new Date(`${dateInput}T00:00:00Z`) : new Date();
      const logDate = ChecklistService.logDateFor(
        habit.cadence,
        Number.isNaN(asked.getTime()) ? new Date() : asked,
      );

      if (!done) {
        await tx.habitLog.deleteMany({ where: { habitId, logDate } });
        return { habitId, logDate: logDate.toISOString().slice(0, 10), done: false };
      }
      const existing = await tx.habitLog.findFirst({ where: { habitId, logDate } });
      if (existing) {
        await tx.habitLog.update({ where: { id: existing.id }, data: { completed: true } });
      } else {
        await tx.habitLog.create({
          data: { tenantId: this.db.tenantId, habitId, memberId, logDate, completed: true },
        });
      }
      return { habitId, logDate: logDate.toISOString().slice(0, 10), done: true };
    });
  }
}
