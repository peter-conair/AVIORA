import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES, PERMISSIONS } from '@aviora/shared';
import type { Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import type { TeamActor } from '../team/team-scope.service';
import { CrmScopeService } from '../crm/crm-scope.service';

export interface IndexCardInput {
  externalCode?: string | null;
  membershipExpiresAt?: string | null;
  birthDate?: string | null;
  idNumber?: string | null;
  note?: string | null;
}

/**
 * The customer index card (docs/66).
 *
 * ABO#, expiry, ID#, date of birth, contact, a note — and the twelve-month grid
 * that is the only thing on the card a computer can answer better than the
 * person holding it.
 */
@Injectable()
export class CustomerIndexService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly scope: CrmScopeService,
    private readonly crypto: FieldEncryptionService,
  ) {}

  private async reachable(tx: Tx, actor: TeamActor, customerId: string, permission: string) {
    const customer = await tx.customer.findFirst({ where: { id: customerId } });
    if (!customer) {
      throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Customer not found' });
    }
    const owners = await this.scope.ownerMemberIds(tx, actor, permission);
    if (!this.scope.canAccess(owners, customer.ownerMemberId)) {
      throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Customer not found' });
    }
    return customer;
  }

  private static day(value?: string | null): Date | null {
    if (!value) return null;
    const d = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  async saveCard(actor: TeamActor, customerId: string, input: IndexCardInput) {
    const updated = await this.db.tx(async (tx) => {
      await this.reachable(tx, actor, customerId, PERMISSIONS.CRM_CUSTOMER_MANAGE);
      return tx.customer.update({
        where: { id: customerId },
        data: {
          ...(input.externalCode === undefined ? {} : { externalCode: input.externalCode }),
          ...(input.note === undefined ? {} : { note: input.note }),
          ...(input.membershipExpiresAt === undefined
            ? {}
            : { membershipExpiresAt: CustomerIndexService.day(input.membershipExpiresAt) }),
          ...(input.birthDate === undefined
            ? {}
            : { birthDate: CustomerIndexService.day(input.birthDate) }),
          ...(input.idNumber === undefined
            ? {}
            : {
                // A national identity number is the most identifying thing on
                // the card and the least often needed. `encrypt` fails closed:
                // with no key configured it throws rather than storing it in
                // the clear (docs/66 §3).
                idNumberEncrypted: input.idNumber ? this.crypto.encrypt(input.idNumber) : null,
              }),
        },
      });
    });
    await this.audit.record({
      action: 'crm.customer.card',
      entityType: 'customer',
      entityId: customerId,
      // Never the values: an audit row repeating an identity number would put
      // it back in the clear in a table read by more people than the card is.
      after: {
        externalCode: !!updated.externalCode,
        idNumber: !!updated.idNumberEncrypted,
        birthDate: !!updated.birthDate,
      },
    });
    return updated;
  }

  /**
   * The card, plus the twelve-month grid for `year`.
   *
   * A month is `ordered` when a real paid order exists in it. Where none does,
   * a hand tick counts — a lot of this business is transacted outside the
   * system, and a grid that could only see what the system sold would be blank
   * for most customers and wrong about all of them.
   *
   * `source` says which, because a month the system saw and a month somebody
   * remembered are not the same claim (docs/58 §3.2).
   */
  async card(actor: TeamActor, customerId: string, year: number, revealId = false) {
    return this.db.tx(async (tx) => {
      const customer = await this.reachable(tx, actor, customerId, PERMISSIONS.CRM_CUSTOMER_VIEW);
      const from = new Date(Date.UTC(year, 0, 1));
      const to = new Date(Date.UTC(year + 1, 0, 1));

      const [orders, ticks] = await Promise.all([
        customer.memberId
          ? tx.order.findMany({
              where: { memberId: customer.memberId, status: 'paid', paidAt: { gte: from, lt: to } },
              select: { paidAt: true, totalMinor: true },
            })
          : Promise.resolve([]),
        tx.customerMonthOrder.findMany({ where: { customerId, year } }),
      ]);

      const paidByMonth = new Map<number, number>();
      for (const order of orders) {
        if (!order.paidAt) continue;
        const month = order.paidAt.getUTCMonth() + 1;
        paidByMonth.set(month, (paidByMonth.get(month) ?? 0) + order.totalMinor);
      }
      const tickedMonths = new Set(ticks.map((t) => t.month));

      const months = Array.from({ length: 12 }, (_, i) => {
        const month = i + 1;
        const paid = paidByMonth.get(month);
        if (paid !== undefined) {
          return { month, ordered: true, source: 'computed' as const, totalMinor: paid };
        }
        return {
          month,
          ordered: tickedMonths.has(month),
          source: 'manual' as const,
          totalMinor: null,
        };
      });

      return {
        year,
        customer: {
          id: customer.id,
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
          externalCode: customer.externalCode,
          membershipExpiresAt: customer.membershipExpiresAt,
          birthDate: customer.birthDate,
          note: customer.note,
          // Whether one is on file, not what it is. Reading it is a separate,
          // audited act (docs/66 §3).
          hasIdNumber: !!customer.idNumberEncrypted,
          ...(revealId ? { idNumber: this.crypto.decrypt(customer.idNumberEncrypted) } : {}),
        },
        months,
        orderedCount: months.filter((m) => m.ordered).length,
      };
    });
  }

  /**
   * Reading the identity number is its own request, and it is audited.
   *
   * Returning it with the card would mean every glance at a customer put their
   * identity number on somebody's screen, and nothing would record that it had
   * happened.
   */
  async revealIdNumber(actor: TeamActor, customerId: string) {
    const card = await this.db.tx(async (tx) => {
      const customer = await this.reachable(tx, actor, customerId, PERMISSIONS.CRM_CUSTOMER_MANAGE);
      return customer;
    });
    if (!card.idNumberEncrypted) {
      throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'No identity number' });
    }
    await this.audit.record({
      action: 'crm.customer.id_number.read',
      entityType: 'customer',
      entityId: customerId,
    });
    return { idNumber: this.crypto.decrypt(card.idNumberEncrypted) };
  }

  /** Tick or un-tick a month the system cannot see. */
  async setMonth(
    actor: TeamActor,
    customerId: string,
    year: number,
    month: number,
    ordered: boolean,
  ) {
    const memberId = actor.memberId;
    if (!memberId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    if (month < 1 || month > 12) {
      throw new ForbiddenException({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'month must be 1–12',
      });
    }
    return this.db.tx(async (tx) => {
      const customer = await this.reachable(tx, actor, customerId, PERMISSIONS.CRM_CUSTOMER_MANAGE);
      if (customer.memberId) {
        const from = new Date(Date.UTC(year, month - 1, 1));
        const to = new Date(Date.UTC(year, month, 1));
        const paid = await tx.order.count({
          where: { memberId: customer.memberId, status: 'paid', paidAt: { gte: from, lt: to } },
        });
        if (paid > 0) {
          // Refused rather than accepted-and-ignored: a hand tick that
          // disagreed with a real order would be a month nobody could resolve.
          throw new ForbiddenException({
            code: ERROR_CODES.CONFLICT,
            message: 'That month already has a paid order, so it is not yours to tick',
          });
        }
      }
      if (ordered) {
        await tx.customerMonthOrder.upsert({
          where: { customerId_year_month: { customerId, year, month } },
          create: {
            tenantId: this.db.tenantId,
            customerId,
            year,
            month,
            markedByMemberId: memberId,
          },
          update: {},
        });
      } else {
        await tx.customerMonthOrder.deleteMany({ where: { customerId, year, month } });
      }
      return { year, month, ordered };
    });
  }
}
