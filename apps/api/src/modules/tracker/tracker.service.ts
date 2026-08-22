import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ERROR_CODES,
  PERMISSIONS,
  TRACKER_TEMPLATE_SEEDS,
  newId,
  type TrackerTemplateSeed,
} from '@aviora/shared';
import { type Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import type { TeamActor } from '../team/team-scope.service';
import { CrmScopeService } from '../crm/crm-scope.service';

type Locale = 'en' | 'th';

/**
 * The tracking sheets (docs/59).
 *
 * One engine; the Follow Up Sheet, Diamond Check List and 6WNY protocol are
 * rows in it. Nothing here knows any column's name — the columns are tenant
 * data, seeded from `TRACKER_TEMPLATE_SEEDS` and editable afterwards, because
 * they name this business's products and another tenant sells something else.
 */
@Injectable()
export class TrackerService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly scope: CrmScopeService,
  ) {}

  /**
   * A tenant that has never opened the editor still gets working sheets, the
   * same way the CRM pipeline seeds itself on first read.
   *
   * Idempotent by template code: a tenant that renamed or deleted a seeded
   * sheet keeps its decision. Re-creating what somebody deliberately removed
   * would be the system arguing with its user.
   */
  private async ensureTemplates(tx: Tx, locale: Locale) {
    const existing = await tx.trackerTemplate.findMany({ select: { code: true } });
    const have = new Set(existing.map((t) => t.code));
    const missing = TRACKER_TEMPLATE_SEEDS.filter((seed) => !have.has(seed.code));
    if (missing.length === 0 || existing.length > 0) {
      // Only seed into a tenant that has none at all. Otherwise a tenant that
      // deleted the Diamond sheet would find it back on the next page load.
      if (existing.length > 0) return;
    }
    for (const seed of missing) {
      await this.createFromSeed(tx, seed, locale);
    }
  }

  private async createFromSeed(tx: Tx, seed: TrackerTemplateSeed, locale: Locale) {
    const templateId = newId();
    await tx.trackerTemplate.create({
      data: {
        id: templateId,
        tenantId: this.db.tenantId,
        code: seed.code,
        name: seed.name[locale],
        description: seed.description[locale],
        subjectType: seed.subjectType,
        order: seed.order,
      },
    });
    await tx.trackerStep.createMany({
      data: seed.steps.map((step, index) => ({
        id: newId(),
        tenantId: this.db.tenantId,
        templateId,
        key: step.key,
        label: step.label[locale],
        stageLabel: step.stage?.[locale] ?? null,
        order: index,
      })),
    });
  }

  async listTemplates(locale: Locale) {
    return this.db.tx(async (tx) => {
      await this.ensureTemplates(tx, locale);
      const templates = await tx.trackerTemplate.findMany({
        where: { isActive: true },
        orderBy: { order: 'asc' },
        include: { steps: { orderBy: { order: 'asc' } } },
      });
      return { templates };
    });
  }

  /** One sheet, filled in: its columns, its rows, and every tick on it. */
  async sheet(actor: TeamActor, code: string, locale: Locale) {
    return this.db.tx(async (tx) => {
      await this.ensureTemplates(tx, locale);
      const template = await tx.trackerTemplate.findFirst({
        where: { code },
        include: { steps: { orderBy: { order: 'asc' } } },
      });
      if (!template) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Sheet not found' });
      }
      const owners = await this.scope.ownerMemberIds(tx, actor, PERMISSIONS.TRACKER_VIEW);
      const entries = await tx.trackerEntry.findMany({
        where: { templateId: template.id, ...this.scope.whereOwner(owners) },
        orderBy: [{ groupLabel: 'asc' }, { startedAt: 'asc' }],
        include: { marks: { select: { stepId: true, markedAt: true } } },
      });

      const names = await this.subjectNames(
        tx,
        template.subjectType,
        entries.map((e) => e.subjectId),
      );

      return {
        template: {
          id: template.id,
          code: template.code,
          name: template.name,
          description: template.description,
          subjectType: template.subjectType,
        },
        // Stages in column order, so the grid can draw the bands the paper
        // draws ("GT Qualification", "day 7") without inventing an order.
        stages: [...new Set(template.steps.map((s) => s.stageLabel).filter(Boolean))],
        steps: template.steps.map((s) => ({
          id: s.id,
          key: s.key,
          label: s.label,
          stageLabel: s.stageLabel,
        })),
        entries: entries.map((entry) => {
          const done = new Set(entry.marks.map((m) => m.stepId));
          return {
            id: entry.id,
            subjectId: entry.subjectId,
            subjectName: names.get(entry.subjectId) ?? null,
            groupLabel: entry.groupLabel,
            startedAt: entry.startedAt,
            lastMarkedAt: entry.lastMarkedAt,
            completedAt: entry.completedAt,
            done: template.steps.filter((s) => done.has(s.id)).map((s) => s.id),
            doneCount: done.size,
            stepCount: template.steps.length,
          };
        }),
      };
    });
  }

  /** Names for whichever kind of person this sheet is about. */
  private async subjectNames(
    tx: Tx,
    subjectType: string,
    ids: string[],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows =
      subjectType === 'member'
        ? await tx.member.findMany({
            where: { id: { in: ids } },
            select: { id: true, displayName: true },
          })
        : subjectType === 'customer'
          ? await tx.customer.findMany({
              where: { id: { in: ids } },
              select: { id: true, name: true },
            })
          : await tx.lead.findMany({
              where: { id: { in: ids } },
              select: { id: true, name: true },
            });
    return new Map(
      rows.map((r) => [
        r.id,
        (r as { displayName?: string; name?: string }).displayName ??
          (r as { name?: string }).name ??
          '',
      ]),
    );
  }

  async addEntry(
    actor: TeamActor,
    code: string,
    input: { subjectId: string; groupLabel?: string | null },
    locale: Locale,
  ) {
    const memberId = actor.memberId;
    if (!memberId) {
      throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Not a member' });
    }
    const entry = await this.db.tx(async (tx) => {
      await this.ensureTemplates(tx, locale);
      const template = await tx.trackerTemplate.findFirst({ where: { code } });
      if (!template) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Sheet not found' });
      }
      const already = await tx.trackerEntry.findFirst({
        where: {
          templateId: template.id,
          subjectType: template.subjectType,
          subjectId: input.subjectId,
        },
      });
      if (already) {
        // Two rows for one person would let them be half-ticked in two places
        // and neither would be the truth.
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'That person is already on this sheet',
          details: { entryId: already.id },
        });
      }
      return tx.trackerEntry.create({
        data: {
          tenantId: this.db.tenantId,
          templateId: template.id,
          subjectType: template.subjectType,
          subjectId: input.subjectId,
          ownerMemberId: memberId,
          groupLabel: input.groupLabel ?? null,
        },
      });
    });
    await this.audit.record({
      action: 'tracker.entry.add',
      entityType: 'tracker_entry',
      entityId: entry.id,
      after: { templateCode: code, subjectId: entry.subjectId },
    });
    return entry;
  }

  /**
   * Tick or un-tick one box.
   *
   * The tick carries a date and who put it there, which is the whole reason
   * this is not a boolean column: "done" cannot answer "nobody in this line has
   * moved in two months", and that is the question the sheet exists to ask.
   */
  async setMark(actor: TeamActor, entryId: string, stepId: string, done: boolean) {
    const result = await this.db.tx(async (tx) => {
      const entry = await tx.trackerEntry.findFirst({ where: { id: entryId } });
      if (!entry) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Row not found' });
      }
      const owners = await this.scope.ownerMemberIds(tx, actor, PERMISSIONS.TRACKER_MANAGE);
      if (!this.scope.canAccess(owners, entry.ownerMemberId)) {
        // A tick is a claim that work was done. A leader reads the line; the
        // person doing the work is the one who says it happened.
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Row not found' });
      }
      const step = await tx.trackerStep.findFirst({
        where: { id: stepId, templateId: entry.templateId },
      });
      if (!step) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Column not found' });
      }

      if (done) {
        await tx.trackerMark.upsert({
          where: { entryId_stepId: { entryId, stepId } },
          create: {
            tenantId: this.db.tenantId,
            entryId,
            stepId,
            markedByMemberId: actor.memberId ?? null,
          },
          // Ticking twice is the same tick: keep the first date, because when
          // it happened is the fact being recorded.
          update: {},
        });
      } else {
        await tx.trackerMark.deleteMany({ where: { entryId, stepId } });
      }

      const marks = await tx.trackerMark.findMany({
        where: { entryId },
        orderBy: { markedAt: 'desc' },
        take: 1,
      });
      const stepCount = await tx.trackerStep.count({ where: { templateId: entry.templateId } });
      const markCount = await tx.trackerMark.count({ where: { entryId } });
      return tx.trackerEntry.update({
        where: { id: entryId },
        data: {
          lastMarkedAt: marks[0]?.markedAt ?? null,
          // A row completes when every column is ticked, and un-completes when
          // one is taken back — otherwise a correction leaves it wrongly done.
          completedAt: stepCount > 0 && markCount === stepCount ? new Date() : null,
        },
      });
    });
    return result;
  }

  /**
   * Who has stopped moving (docs/59 §5).
   *
   * The one thing the paper sheet cannot do. Counting ticks by eye tells you
   * who has done the most; it cannot tell you who was doing well and stopped,
   * which is the person a coach actually needs to ring.
   */
  async stalled(actor: TeamActor, days: number, locale: Locale) {
    return this.db.tx(async (tx) => {
      await this.ensureTemplates(tx, locale);
      const owners = await this.scope.ownerMemberIds(tx, actor, PERMISSIONS.TRACKER_VIEW);
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const entries = await tx.trackerEntry.findMany({
        where: {
          completedAt: null,
          ...this.scope.whereOwner(owners),
          OR: [
            { lastMarkedAt: { lt: cutoff } },
            // Started and never touched at all is the worst kind of stalled,
            // and a `lastMarkedAt < cutoff` filter alone would miss it because
            // the column is still null.
            { lastMarkedAt: null, startedAt: { lt: cutoff } },
          ],
        },
        orderBy: [{ lastMarkedAt: 'asc' }, { startedAt: 'asc' }],
        take: 50,
        include: { template: { select: { code: true, name: true, subjectType: true } } },
      });
      const byType = new Map<string, string[]>();
      for (const e of entries) {
        byType.set(e.template.subjectType, [
          ...(byType.get(e.template.subjectType) ?? []),
          e.subjectId,
        ]);
      }
      const names = new Map<string, string>();
      for (const [type, ids] of byType) {
        for (const [id, name] of await this.subjectNames(tx, type, ids)) names.set(id, name);
      }
      return {
        days,
        stalled: entries.map((e) => ({
          entryId: e.id,
          sheet: e.template.name,
          sheetCode: e.template.code,
          subjectId: e.subjectId,
          subjectName: names.get(e.subjectId) ?? null,
          groupLabel: e.groupLabel,
          lastMarkedAt: e.lastMarkedAt,
          startedAt: e.startedAt,
          neverStarted: e.lastMarkedAt === null,
        })),
      };
    });
  }
}
