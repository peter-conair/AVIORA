/**
 * The two ways the CRM decides "same person" (docs/55 §2).
 *
 * The fallback path — no index key configured — is the one that would run on a
 * deployment that upgraded without setting the variable, and an untested
 * fallback is how a duplicate check silently stops checking.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { BlindIndexService } from '../../common/crypto/blind-index.service';
import { ContactKeyService } from './contact-key.service';

const KEY = Buffer.alloc(32, 11).toString('base64');
let svc: ContactKeyService;

beforeEach(() => {
  process.env.AVIORA_BLIND_INDEX_KEY = KEY;
  svc = new ContactKeyService(new BlindIndexService());
});

describe('with an index key (the intended state)', () => {
  it('matches on the digest, not the column', () => {
    const where = svc.matchWhere({ email: 'Ada@Example.com' }) as { OR: { emailBidx: string }[] };
    expect(where.OR[0]!.emailBidx).toBe(new BlindIndexService().email('ada@example.com'));
  });

  it('matches either contact, so one shared detail is enough', () => {
    const where = svc.matchWhere({ email: 'a@b.co', phone: '0812345678' }) as { OR: unknown[] };
    expect(where.OR).toHaveLength(2);
  });
});

describe('without an index key (the fallback)', () => {
  beforeEach(() => {
    delete process.env.AVIORA_BLIND_INDEX_KEY;
    svc = new ContactKeyService(new BlindIndexService());
  });

  it('compares the plaintext columns instead of throwing', () => {
    // Fail-closed is right for the index itself; here it would take lead
    // creation down across a deployment that merely forgot a variable.
    const where = svc.matchWhere({ email: 'ada@example.com' }) as {
      OR: { email: { equals: string; mode: string } }[];
    };
    expect(where.OR[0]!.email.mode).toBe('insensitive');
  });

  it('matches a phone only if it was typed the same way twice', () => {
    // The weakness, pinned rather than described: normalising a phone in SQL
    // would mean a second copy of "last 9 digits", which is the drift this
    // design exists to avoid. So the fallback is exact — and docs/55 §2.1 says
    // so, after first claiming otherwise and being caught by CI.
    const where = svc.matchWhere({ phone: '+66 81-234-5678' }) as { OR: { phone: string }[] };
    expect(where.OR[0]!.phone).toBe('+66 81-234-5678');
  });

  it('stamps no digests, so no row claims an index it does not have', () => {
    expect(svc.keys({ email: 'ada@example.com' })).toEqual({ emailBidx: null, phoneBidx: null });
    expect(svc.usingIndex).toBe(false);
  });
});

describe('nothing to match on matches nothing', () => {
  it.each([
    ['no contact at all', {}],
    ['blank strings', { email: '   ', phone: '' }],
    ['a phone with no digits', { phone: 'n/a' }],
  ])('%s', (_label, input) => {
    // An unguarded OR over two nulls matches every row with a blank email,
    // which would block every walk-in who gave only a name.
    expect(svc.matchWhere(input)).toBeNull();
  });
});
