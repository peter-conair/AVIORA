import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ERROR_CODES,
  MEMORY_JOGGER,
  NAME_LIST_TARGET,
  PERMISSIONS,
  PROSPECT_SCORE_MAX,
  PROSPECT_SCORE_MIN,
  allJoggerPrompts,
  criteriaFor,
  joggerCategoryOf,
  listScore,
  listScoreMax,
  type ProspectList,
  type ProspectScores,
} from '@aviora/shared';
import { Prisma } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import type { TeamActor } from '../team/team-scope.service';
import { CrmScopeService } from './crm-scope.service';

/**
 * The prospecting workbook (docs/56): two scored name lists and the Memory
 * Jogger that fills them.
 *
 * This is the paper the business already runs on, so the shapes here follow the
 * sheet rather than inventing a better one — twenty rows, the same column
 * headings, one row per person.
 */
@Injectable()
export class ProspectingService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly scope: CrmScopeService,
  ) {}

  /** A name list is one salesperson's own book — never the whole tenant's. */
  private listFilter(list: ProspectList): Record<string, unknown> {
    return list === 'sponsor' ? { onSponsorList: true } : { onCustomerList: true };
  }

  async nameList(actor: TeamActor, list: ProspectList, locale: 'en' | 'th' = 'th') {
    return this.db.tx(async (tx) => {
      const owners = await this.scope.ownerMemberIds(tx, actor, PERMISSIONS.CRM_LEAD_VIEW);
      const rows = await tx.lead.findMany({
        where: { status: 'open', ...this.listFilter(list), ...this.scope.whereOwner(owners) },
        orderBy: [
          { [list === 'sponsor' ? 'sponsorScore' : 'customerScore']: 'desc' },
          { createdAt: 'asc' },
        ],
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          scores: true,
          sponsorScore: true,
          customerScore: true,
          joggerPrompt: true,
          stageId: true,
          lastContactAt: true,
          createdAt: true,
        },
      });
      const max = listScoreMax(list);
      return {
        list,
        // The sheet's twenty rows are the exercise, so the screen needs to know
        // how far off it is — not just what has been written down.
        target: NAME_LIST_TARGET,
        filled: rows.length,
        remaining: Math.max(0, NAME_LIST_TARGET - rows.length),
        // Localised here, not shipped raw. The shared constant carries every
        // language, and handing that to a screen makes the screen pick — which
        // it did by rendering the whole object and taking the page down with
        // it (docs/56 §5.1).
        criteria: criteriaFor(list).map((c) => ({
          key: c.key,
          label: c.label[locale],
          help: c.help[locale],
        })),
        scoreMax: max,
        entries: rows.map((row) => ({
          ...row,
          score: list === 'sponsor' ? row.sponsorScore : row.customerScore,
          scoreMax: max,
          // Unrated is not the same as rated zero, and a screen that cannot
          // tell them apart shows a full sheet of names all tied at the bottom.
          rated: criteriaFor(list).every(
            (c) => Number((row.scores as ProspectScores)?.[c.key]) > 0,
          ),
        })),
      };
    });
  }

  /**
   * Rate a name, and/or put it on a list.
   *
   * Both totals are recomputed on every write, not just the list being edited:
   * `money` and `relation` are shared, so rating somebody as a customer also
   * changes what they are worth as a sponsor. Recomputing one would leave the
   * other quietly stale.
   */
  async setScores(
    id: string,
    input: { scores?: ProspectScores; onSponsorList?: boolean; onCustomerList?: boolean },
    actor: TeamActor,
  ) {
    const lead = await this.db.tx(async (tx) => {
      const before = await tx.lead.findFirst({ where: { id } });
      if (!before) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Lead not found' });
      }
      const owners = await this.scope.ownerMemberIds(tx, actor, PERMISSIONS.CRM_LEAD_MANAGE);
      if (!this.scope.canAccess(owners, before.ownerMemberId)) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Lead not found' });
      }
      const merged: ProspectScores = {
        ...((before.scores as ProspectScores) ?? {}),
        ...(input.scores ?? {}),
      };
      // Drop anything out of range rather than storing it: a 9 in a 1..5 field
      // would sort a name to the top of a list it never earned.
      for (const [key, value] of Object.entries(merged)) {
        const n = Number(value);
        if (!Number.isInteger(n) || n < PROSPECT_SCORE_MIN || n > PROSPECT_SCORE_MAX) {
          delete merged[key];
        }
      }
      return tx.lead.update({
        where: { id },
        data: {
          scores: merged,
          sponsorScore: listScore('sponsor', merged),
          customerScore: listScore('customer', merged),
          ...(input.onSponsorList === undefined ? {} : { onSponsorList: input.onSponsorList }),
          ...(input.onCustomerList === undefined ? {} : { onCustomerList: input.onCustomerList }),
        },
      });
    });
    await this.audit.record({
      action: 'crm.lead.score',
      entityType: 'lead',
      entityId: id,
      after: { sponsorScore: lead.sponsorScore, customerScore: lead.customerScore },
    });
    return lead;
  }

  /** The catalogue, localised, with how many names each prompt has produced. */
  async memoryJogger(actor: TeamActor, locale: 'en' | 'th') {
    return this.db.tx(async (tx) => {
      const owners = await this.scope.ownerMemberIds(tx, actor, PERMISSIONS.CRM_LEAD_VIEW);
      const counts = await tx.lead.groupBy({
        by: ['joggerPrompt'],
        where: { joggerPrompt: { not: null }, ...this.scope.whereOwner(owners) },
        _count: { _all: true },
      });
      const used = new Map(counts.map((c) => [c.joggerPrompt as string, c._count._all]));
      return {
        categories: MEMORY_JOGGER.map((category) => ({
          key: category.key,
          label: category.label[locale],
          prompts: category.prompts.map((prompt) => ({
            key: prompt.key,
            label: prompt.label[locale],
            // Shown as a tick on the paper. Here it is a count, so a prompt
            // that produced six names reads differently from one that produced
            // one — the paper cannot tell you that.
            named: used.get(prompt.key) ?? 0,
          })),
        })),
        total: [...used.values()].reduce((a, b) => a + b, 0),
      };
    });
  }

  /**
   * What the coach asks for at the weekly meeting (docs/56 §6).
   *
   * Deliberately not a dashboard of everything: it answers "are the lists full,
   * who do I call next, and where are my names actually coming from".
   */
  async report(actor: TeamActor) {
    return this.db.tx(async (tx) => {
      const owners = await this.scope.ownerMemberIds(tx, actor, PERMISSIONS.CRM_LEAD_VIEW);
      const mine = { status: 'open', ...this.scope.whereOwner(owners) };

      const lists = await Promise.all(
        (['sponsor', 'customer'] as const).map(async (list) => {
          const where = { ...mine, ...this.listFilter(list) };
          const [filled, top] = await Promise.all([
            tx.lead.count({ where }),
            tx.lead.findMany({
              where,
              orderBy: { [list === 'sponsor' ? 'sponsorScore' : 'customerScore']: 'desc' },
              take: 5,
              select: {
                id: true,
                name: true,
                sponsorScore: true,
                customerScore: true,
                lastContactAt: true,
              },
            }),
          ]);
          return {
            list,
            filled,
            target: NAME_LIST_TARGET,
            remaining: Math.max(0, NAME_LIST_TARGET - filled),
            scoreMax: listScoreMax(list),
            top: top.map((t) => ({
              id: t.id,
              name: t.name,
              score: list === 'sponsor' ? t.sponsorScore : t.customerScore,
              lastContactAt: t.lastContactAt,
            })),
          };
        }),
      );

      const byPrompt = await tx.lead.groupBy({
        by: ['joggerPrompt'],
        where: { joggerPrompt: { not: null }, ...this.scope.whereOwner(owners) },
        _count: { _all: true },
      });
      const produced = new Map(byPrompt.map((r) => [r.joggerPrompt as string, r._count._all]));

      // Every prompt, including the ones that produced nothing — the zeroes are
      // the point. A report listing only what worked cannot tell you what you
      // have not tried.
      const prompts = allJoggerPrompts().map((entry) => ({
        ...entry,
        named: produced.get(entry.key) ?? 0,
      }));

      const unrated = await tx.lead.count({
        where: {
          ...mine,
          OR: [{ onSponsorList: true }, { onCustomerList: true }],
          // Prisma spells "the JSON column is SQL NULL" this way; `null` alone
          // means the JSON value `null`, which is a different row.
          scores: { equals: Prisma.DbNull },
        },
      });

      return {
        lists,
        // Names on a list with no rating are the work the coach should push on:
        // they look like progress and are not.
        unrated,
        joggerCategories: MEMORY_JOGGER.map((c) => ({
          key: c.key,
          named: c.prompts.reduce((sum, pr) => sum + (produced.get(pr.key) ?? 0), 0),
        })),
        prompts,
      };
    });
  }

  static categoryOf(promptKey: string | null | undefined): string | null {
    return promptKey ? joggerCategoryOf(promptKey) : null;
  }
}
