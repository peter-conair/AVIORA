/**
 * The blind index's own tests (docs/54).
 *
 * Determinism is the easy half. The half that decides whether this is usable is
 * NORMALISATION: an index that misses because somebody typed a space is an
 * index that sends a salesperson back to plaintext.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { BlindIndexService } from './blind-index.service';

const KEY_A = Buffer.alloc(32, 7).toString('base64');
const KEY_B = Buffer.alloc(32, 9).toString('base64');
let svc: BlindIndexService;

beforeEach(() => {
  process.env.AVIORA_BLIND_INDEX_KEY = KEY_A;
  svc = new BlindIndexService();
});

describe('It finds the same value written differently', () => {
  it('treats an address as one address however it was typed', () => {
    const canonical = svc.email('ada@example.com');
    expect(svc.email('  Ada@Example.COM  ')).toBe(canonical);
    expect(svc.email('ADA@EXAMPLE.COM')).toBe(canonical);
  });

  it('treats a Thai number as one number however it was written', () => {
    // The case that decides this is worth having: three spellings a salesperson
    // uses interchangeably, which byte comparison finds nothing for.
    const canonical = svc.phone('0812345678');
    expect(svc.phone('+66 81-234-5678')).toBe(canonical);
    expect(svc.phone('081 234 5678')).toBe(canonical);
    expect(svc.phone('(081) 234-5678')).toBe(canonical);
  });

  it('keeps genuinely different values apart', () => {
    expect(svc.email('ada@example.com')).not.toBe(svc.email('bob@example.com'));
    expect(svc.phone('0812345678')).not.toBe(svc.phone('0812345679'));
    // Distinct mailboxes on one host stay distinct: the local part is
    // case-insensitive by convention but not by RFC, and merging them would
    // merge two people.
    expect(svc.email('a.da@example.com')).not.toBe(svc.email('ada@example.com'));
  });
});

describe('The key is what makes it blind', () => {
  it('produces a different index under a different key', () => {
    const underA = svc.email('ada@example.com');
    process.env.AVIORA_BLIND_INDEX_KEY = KEY_B;
    expect(
      new BlindIndexService().email('ada@example.com'),
      'the index does not depend on the key, so it is a plain hash anybody can ' +
        'compute — and an email is guessable',
    ).not.toBe(underA);
  });

  it('refuses to compute anything without a key', () => {
    delete process.env.AVIORA_BLIND_INDEX_KEY;
    const unconfigured = new BlindIndexService();
    // Failing closed matters more here than for encryption: an index computed
    // with a missing key would be a constant, and every row would match every
    // lookup.
    expect(() => unconfigured.email('ada@example.com')).toThrow(/not configured/i);
    expect(unconfigured.isConfigured).toBe(false);
  });

  it('refuses a key that is too short to be one', () => {
    process.env.AVIORA_BLIND_INDEX_KEY = Buffer.alloc(8, 1).toString('base64');
    expect(() => new BlindIndexService().email('ada@example.com')).toThrow(/32 bytes/);
  });
});

describe('Nothing indexes to a value that would match everything', () => {
  it('returns null for absent input rather than the digest of ""', () => {
    for (const empty of [null, undefined, '', '   ']) {
      expect(svc.email(empty)).toBeNull();
      expect(svc.phone(empty)).toBeNull();
    }
  });

  it('returns null for a "phone" with no digits in it', () => {
    // Otherwise every unparseable phone shares one index and a lookup on it
    // returns all of them.
    expect(svc.phone('n/a')).toBeNull();
    expect(svc.phone('---')).toBeNull();
  });
});
