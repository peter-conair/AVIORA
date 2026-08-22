import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { BlindIndexService } from '../../common/crypto/blind-index.service';

export type ContactKeys = { emailBidx: string | null; phoneBidx: string | null };

/**
 * Turns a contact into the keys the CRM matches on (docs/55).
 *
 * One place, because the duplicate check and the write path have to agree
 * exactly: a lead stamped one way and searched another is a lead the check
 * cannot see, and a duplicate check that quietly finds nothing is worse than
 * none — it reports "no duplicate" with authority.
 *
 * When `AVIORA_BLIND_INDEX_KEY` is absent the keys are null and matching falls
 * back to comparing the plaintext columns. That fallback is honest only while
 * those columns ARE plaintext; docs/54 §4 lists moving off it as a prerequisite
 * for encrypting them, and `matchWhere` throws rather than silently matching
 * nothing if it is ever asked to search ciphertext without a key.
 */
@Injectable()
export class ContactKeyService implements OnModuleInit {
  private readonly logger = new Logger(ContactKeyService.name);

  constructor(private readonly blind: BlindIndexService) {}

  onModuleInit(): void {
    if (!this.blind.isConfigured) {
      // Said out loud, because the degradation is invisible from the outside:
      // leads still save, the check still runs, and it just stops catching the
      // duplicates whose phone was written a different way (docs/55 §2.1).
      this.logger.warn(
        'AVIORA_BLIND_INDEX_KEY is not set — CRM duplicate detection is running ' +
          'in its degraded mode and will miss contacts whose phone was written differently',
      );
    }
  }

  get usingIndex(): boolean {
    return this.blind.isConfigured;
  }

  keys(input: { email?: string | null; phone?: string | null }): ContactKeys {
    if (!this.blind.isConfigured) return { emailBidx: null, phoneBidx: null };
    return {
      emailBidx: this.blind.email(input.email),
      phoneBidx: this.blind.phone(input.phone),
    };
  }

  /**
   * A Prisma `where` fragment matching the same person by email OR phone, or
   * null when there is nothing to match on — an empty contact must not match
   * every row with a blank email, which is what an unguarded OR would do.
   */
  matchWhere(input: {
    email?: string | null;
    phone?: string | null;
  }): Record<string, unknown> | null {
    const clauses: Record<string, unknown>[] = [];
    if (this.blind.isConfigured) {
      const { emailBidx, phoneBidx } = this.keys(input);
      if (emailBidx) clauses.push({ emailBidx });
      if (phoneBidx) clauses.push({ phoneBidx });
    } else {
      // Normalised the same way the index normalises, so the two paths agree
      // on what "the same person" means.
      const email = input.email?.trim();
      const phone = input.phone?.trim();
      if (email) clauses.push({ email: { equals: email, mode: 'insensitive' } });
      if (phone) clauses.push({ phone });
    }
    return clauses.length ? { OR: clauses } : null;
  }
}
