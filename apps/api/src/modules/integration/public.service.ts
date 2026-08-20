import { Injectable } from '@nestjs/common';
import { TenantDb } from '../../common/db/tenant-db.service';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface Page<T> {
  data: T[];
  /** Pass back as `?cursor=` for the next page; null when this is the last one. */
  next_cursor: string | null;
}

export interface PageQuery {
  limit?: number;
  cursor?: string;
}

/**
 * The public API's reads (docs/30 §3, §6): members, orders, ranks.
 *
 * Deliberately narrow, and read-only this sprint — there are no writes here
 * and no route that could accept one. It grows when somebody asks, not in
 * anticipation.
 *
 * Nothing in this file touches a health table, and nothing may: docs/30 §7
 * refuses health endpoints on the public API by RULE rather than by omission,
 * so a later reader knows the absence was a decision.
 *
 * Every read goes through TenantDb, so RLS and the tenant extension apply
 * exactly as they do for a person — the API key changed who is asking, not
 * what may be seen.
 */
@Injectable()
export class PublicApiService {
  constructor(private readonly db: TenantDb) {}

  async members(query: PageQuery): Promise<Page<unknown>> {
    const take = clamp(query.limit);
    const rows = await this.db.tx((tx) =>
      tx.member.findMany({
        ...cursor(query, take),
        orderBy: { id: 'asc' },
        select: {
          id: true,
          code: true,
          displayName: true,
          status: true,
          joinedAt: true,
        },
      }),
    );
    return page(rows, take);
  }

  async orders(query: PageQuery): Promise<Page<unknown>> {
    const take = clamp(query.limit);
    const rows = await this.db.tx((tx) =>
      tx.order.findMany({
        ...cursor(query, take),
        orderBy: { id: 'asc' },
        select: {
          id: true,
          number: true,
          memberId: true,
          status: true,
          currency: true,
          subtotalMinor: true,
          discountMinor: true,
          taxMinor: true,
          totalMinor: true,
          placedAt: true,
          paidAt: true,
          cancelledAt: true,
        },
      }),
    );
    return page(rows, take);
  }

  /** The ladder itself — definitions, not any member's position on it. */
  async ranks(query: PageQuery): Promise<Page<unknown>> {
    const take = clamp(query.limit);
    const rows = await this.db.tx((tx) =>
      tx.rankDefinition.findMany({
        ...cursor(query, take),
        orderBy: { id: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
          level: true,
          status: true,
          requalifyWindowDays: true,
        },
      }),
    );
    return page(rows, take);
  }
}

function clamp(limit: number | undefined): number {
  if (!limit || Number.isNaN(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

/**
 * Keyset pagination on the primary key. Ids are uuid v7 — time-ordered — so
 * ordering by id is also ordering by creation, and a page boundary stays
 * stable while rows are being inserted. Offsets would not.
 */
function cursor(query: PageQuery, take: number) {
  return {
    take: take + 1, // one extra row answers "is there a next page?"
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  };
}

function page<T extends { id: string }>(rows: T[], take: number): Page<T> {
  const hasMore = rows.length > take;
  const data = hasMore ? rows.slice(0, take) : rows;
  return { data, next_cursor: hasMore ? (data[data.length - 1]?.id ?? null) : null };
}
