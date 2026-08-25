import { ConflictException, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@aviora/shared';
import { PrismaService } from '../../common/db/prisma.service';
import { sha256Hex } from './webhook';

/** How long a caller may retry and still be told what the first attempt did. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotentCall {
  /** The API key that presented it — two integrations may pick the same string. */
  callerId: string;
  route: string;
  /** The `Idempotency-Key` header, or null when the caller sent none. */
  key: string | null;
  /** The request body, hashed so the same key with a different body is caught. */
  body: unknown;
}

export interface IdempotentOutcome<T> {
  response: T;
  /** True when this answer came from a record rather than from doing the work. */
  replayed: boolean;
}

/**
 * Makes a write safely repeatable (docs/74 §4).
 *
 * The catalogue ingest is already idempotent by its natural key — the same SKU
 * twice is one product. What this adds is that the ANSWER is idempotent too. A
 * caller whose connection dropped after the write and before the response
 * retries and learns what the first attempt did; without this it reads
 * `unchanged` for work it does not know it performed, which is indistinguishable
 * from the write having been lost.
 *
 * Stored through the owner client: the record belongs to no tenant, and the
 * table carries no policy and no grant to the app role.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async run<T>(call: IdempotentCall, work: () => Promise<T>): Promise<IdempotentOutcome<T>> {
    // No key, no promise. The caller has not asked to be able to retry, and
    // inventing one from the body would make two deliberate identical syncs
    // into one — which is exactly what a scheduled hourly sync looks like.
    if (!call.key) return { response: await work(), replayed: false };

    const requestHash = sha256Hex(JSON.stringify(call.body ?? null));
    const where = {
      callerId_route_key: { callerId: call.callerId, route: call.route, key: call.key },
    };

    const existing = await this.prisma.owner.idempotencyRecord.findUnique({ where });
    if (existing) return this.replay<T>(existing.requestHash, requestHash, existing.response);

    const response = await work();

    try {
      await this.prisma.owner.idempotencyRecord.create({
        data: {
          callerId: call.callerId,
          route: call.route,
          key: call.key,
          requestHash,
          statusCode: 200,
          response: response as object,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
        },
      });
    } catch {
      // Two requests with one key arrived at once, and the other won the insert.
      // The work has run twice — the natural key made that harmless — but the
      // ANSWER must still be the one recorded, or the two callers disagree
      // about what happened.
      const raced = await this.prisma.owner.idempotencyRecord.findUnique({ where });
      if (raced) return this.replay<T>(raced.requestHash, requestHash, raced.response);
    }

    return { response, replayed: false };
  }

  /**
   * The same key with a different body is a MISTAKE, not a retry — a sender
   * reusing a key across two batches. Replaying the first batch's answer would
   * report the second as written when nothing of it was.
   */
  private replay<T>(stored: string, presented: string, response: unknown): IdempotentOutcome<T> {
    if (stored !== presented) {
      throw new ConflictException({
        code: ERROR_CODES.CONFLICT,
        message:
          'This Idempotency-Key was used with a different request body. Use a new key ' +
          'for a new batch, or resend the batch the key was first used with.',
      });
    }
    return { response: response as T, replayed: true };
  }
}
