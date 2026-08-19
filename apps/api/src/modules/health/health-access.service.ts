import { ForbiddenException, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@aviora/shared';
import type { Tx } from '@aviora/db';

/**
 * Who may see whose health data (spec §59).
 *
 * The rule is deliberately narrower than every other domain in the platform:
 * being a leader, a coach, or even the tenant owner grants NOTHING here. Access
 * to another member's health data exists only where that member created a grant
 * and has not revoked it. There is no admin override — an override would make
 * the promise to members untrue.
 */
@Injectable()
export class HealthAccessService {
  /** The member is always allowed to see their own data. */
  async assertCanView(tx: Tx, actorMemberId: string | null, subjectMemberId: string) {
    if (!actorMemberId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    if (actorMemberId === subjectMemberId) return;

    const grant = await tx.healthDataGrant.findFirst({
      where: { memberId: subjectMemberId, granteeMemberId: actorMemberId, revokedAt: null },
    });
    if (!grant) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'This member has not shared their health data with you',
      });
    }
  }

  /** Writing health data is always self-only — a grant never confers write. */
  assertCanEdit(actorMemberId: string | null, subjectMemberId: string) {
    if (!actorMemberId || actorMemberId !== subjectMemberId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Health data can only be edited by the member it belongs to',
      });
    }
  }
}
