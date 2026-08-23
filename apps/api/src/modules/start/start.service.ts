import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ERROR_CODES,
  START_NAMES_TARGET,
  START_STEPS,
  START_TEMPLATE_CODE,
  newId,
  type StartStep,
} from '@aviora/shared';
import type { Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import type { TeamActor } from '../team/team-scope.service';
import { BusinessGoalService } from '../goals-business/business-goal.service';

type Locale = 'en' | 'th';

/**
 * Starting the business (docs/63).
 *
 * One ordered path, and — the point of it — **most of it is read, not asked**.
 * A goal row exists or it does not; a name list has ten names in it or it does
 * not. Asking a new member to tick a box the system could have looked up is how
 * a checklist stops being believed on about the third day.
 */
@Injectable()
export class StartService {
  constructor(private readonly db: TenantDb) {}

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
   * The template the handful of manual steps are recorded against.
   *
   * Reuses the tracker engine rather than adding a table: a manual start step
   * IS a dated tick against a named step, which is what that engine stores
   * (docs/59). Hidden from the sheet list because it is not a sheet anybody
   * fills in for somebody else.
   */
  private async ensureTemplate(tx: Tx, locale: Locale) {
    const existing = await tx.trackerTemplate.findFirst({
      where: { code: START_TEMPLATE_CODE },
      include: { steps: true },
    });
    if (existing) return existing;
    const templateId = newId();
    await tx.trackerTemplate.create({
      data: {
        id: templateId,
        tenantId: this.db.tenantId,
        code: START_TEMPLATE_CODE,
        name: locale === 'en' ? 'Getting started' : 'เริ่มต้นธุรกิจ',
        subjectType: 'member',
        isActive: false,
        order: 0,
      },
    });
    const manual = START_STEPS.filter((s) => s.derived === null);
    await tx.trackerStep.createMany({
      data: manual.map((step, index) => ({
        id: newId(),
        tenantId: this.db.tenantId,
        templateId,
        key: step.key,
        label: step.label[locale],
        order: index,
      })),
    });
    return tx.trackerTemplate.findFirst({
      where: { id: templateId },
      include: { steps: true },
    });
  }

  private async entryFor(tx: Tx, templateId: string, memberId: string) {
    const existing = await tx.trackerEntry.findFirst({
      where: { templateId, subjectType: 'member', subjectId: memberId },
    });
    if (existing) return existing;
    return tx.trackerEntry.create({
      data: {
        tenantId: this.db.tenantId,
        templateId,
        subjectType: 'member',
        subjectId: memberId,
        ownerMemberId: memberId,
      },
    });
  }

  /** Everything the system can prove about this member, in one pass. */
  private async evidence(tx: Tx, memberId: string): Promise<Record<string, boolean>> {
    const month = BusinessGoalService.monthOf();
    const [goal, names, course, checklist, customers, partners] = await Promise.all([
      tx.businessGoal.findFirst({ where: { memberId } }),
      tx.lead.count({
        where: { ownerMemberId: memberId, OR: [{ onSponsorList: true }, { onCustomerList: true }] },
      }),
      tx.learningProgress.count({ where: { memberId } }),
      tx.habitLog.count({ where: { memberId, completed: true, habit: { category: 'business' } } }),
      tx.customer.count({ where: { ownerMemberId: memberId } }),
      tx.referralRelationship.count({
        where: { referrerMemberId: memberId, effectiveTo: null },
      }),
    ]);
    const thisMonthGoal = await tx.businessGoal.findFirst({ where: { memberId, month } });
    return {
      // A dream is written once and stands; the target is per month, so they
      // are different questions even though they live on one sheet.
      dream: !!goal?.lifeGoal?.trim(),
      goal:
        !!thisMonthGoal &&
        ((thisMonthGoal.volumeTargetMinor ?? 0) > 0 || (thisMonthGoal.newPartnersTarget ?? 0) > 0),
      names: names >= START_NAMES_TARGET,
      course: course > 0,
      checklist: checklist > 0,
      customer: customers > 0,
      partner: partners > 0,
    };
  }

  async status(actor: TeamActor, locale: Locale = 'th') {
    const memberId = this.requireMember(actor);
    return this.db.tx(async (tx) => {
      const template = await this.ensureTemplate(tx, locale);
      const entry = await this.entryFor(tx, template!.id, memberId);
      const [marks, evidence] = await Promise.all([
        tx.trackerMark.findMany({ where: { entryId: entry.id }, select: { stepId: true } }),
        this.evidence(tx, memberId),
      ]);
      const markedStepIds = new Set(marks.map((m) => m.stepId));
      const stepIdByKey = new Map(template!.steps.map((s) => [s.key, s.id]));

      const steps = START_STEPS.map((step: StartStep) => {
        const done = step.derived
          ? (evidence[step.derived] ?? false)
          : markedStepIds.has(stepIdByKey.get(step.key) ?? '');
        return {
          key: step.key,
          label: step.label[locale],
          hint: step.hint[locale],
          href: step.href,
          done,
          // Which kind it is, said out loud: a step the system read and a step
          // somebody ticked look identical otherwise (docs/58 §3.2).
          source: step.derived ? ('computed' as const) : ('manual' as const),
        };
      });

      const doneCount = steps.filter((s) => s.done).length;
      return {
        steps,
        doneCount,
        total: steps.length,
        // The one thing a new member actually needs: what to do NEXT, rather
        // than eight cards that are all empty.
        next: steps.find((s) => !s.done) ?? null,
        complete: doneCount === steps.length,
      };
    });
  }

  /** Tick or un-tick one of the steps the system cannot see. */
  async setManual(actor: TeamActor, key: string, done: boolean, locale: Locale = 'th') {
    const memberId = this.requireMember(actor);
    const step = START_STEPS.find((s) => s.key === key);
    if (!step) {
      throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Step not found' });
    }
    if (step.derived) {
      // Otherwise a member could tick "first customer" without having one, and
      // the path would say something the data flatly contradicts.
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'That step is decided by your own records, not by ticking it',
      });
    }
    return this.db.tx(async (tx) => {
      const template = await this.ensureTemplate(tx, locale);
      const entry = await this.entryFor(tx, template!.id, memberId);
      const trackerStep = template!.steps.find((s) => s.key === key);
      if (!trackerStep) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Step not found' });
      }
      if (done) {
        await tx.trackerMark.upsert({
          where: { entryId_stepId: { entryId: entry.id, stepId: trackerStep.id } },
          create: {
            tenantId: this.db.tenantId,
            entryId: entry.id,
            stepId: trackerStep.id,
            markedByMemberId: memberId,
          },
          update: {},
        });
      } else {
        await tx.trackerMark.deleteMany({ where: { entryId: entry.id, stepId: trackerStep.id } });
      }
      return { key, done };
    });
  }
}
