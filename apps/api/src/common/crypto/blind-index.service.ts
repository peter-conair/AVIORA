import * as crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';

/**
 * Blind index for exact-match lookup on encrypted columns (docs/13 §encryption,
 * docs/54).
 *
 * docs/13 has promised this since it was written and never had it, which is
 * why CRM contact data is still plaintext: encrypting `email` forecloses "find
 * the lead with this email", the most ordinary request a CRM gets, unless
 * something deterministic can be searched instead.
 *
 * `HMAC-SHA256(index_key, normalised(value))` is that something. Equal values
 * produce equal digests, so an exact-match lookup still works; the digest
 * reveals nothing about the value without the key.
 *
 * Three properties this depends on, each of which is a way to get it wrong:
 *
 * 1. **A SEPARATE key from the encryption key.** Same key for both means one
 *    compromise loses both the ciphertext and the ability to confirm guesses
 *    against it.
 * 2. **Normalisation, or the index is useless.** `Ada@Example.COM ` and
 *    `ada@example.com` are the same address to every human and to the login
 *    form; unnormalised they produce different digests and the lookup misses.
 *    Phones are worse — `+66 81-234-5678` and `0812345678` are one number.
 * 3. **It is not a hash of a secret.** An email is low-entropy: anybody holding
 *    the index key can confirm whether a known address is present. That is
 *    inherent to deterministic search, and §4 of docs/54 says so out loud
 *    rather than letting the word "hash" imply more.
 */
@Injectable()
export class BlindIndexService {
  private key(): Buffer {
    const raw = process.env.AVIORA_BLIND_INDEX_KEY;
    if (!raw) {
      // Fail closed, like the encryption service: an index computed with no key
      // would be a constant, and every row would match every lookup.
      throw new Error('AVIORA_BLIND_INDEX_KEY is not configured; refusing to compute an index');
    }
    const key = Buffer.from(raw, 'base64');
    if (key.length < 32) {
      throw new Error('AVIORA_BLIND_INDEX_KEY must be at least 32 bytes, base64-encoded');
    }
    return key;
  }

  get isConfigured(): boolean {
    return !!process.env.AVIORA_BLIND_INDEX_KEY;
  }

  /** Lower-cased and trimmed. Nothing else — the local part of an address is case-sensitive per RFC, and stripping more would merge distinct mailboxes. */
  static normaliseEmail(value: string): string {
    return value.trim().toLowerCase();
  }

  /**
   * Digits only, and the last 9 of them.
   *
   * `+66 81-234-5678`, `081-234-5678` and `0812345678` are one Thai number
   * written three ways; comparing them character by character finds nothing.
   * Taking the last 9 digits drops the country code and the trunk `0` that
   * appear or vanish depending on who typed it.
   */
  static normalisePhone(value: string): string {
    const digits = value.replace(/\D/g, '');
    return digits.length > 9 ? digits.slice(-9) : digits;
  }

  private digest(normalised: string): string {
    return crypto.createHmac('sha256', this.key()).update(normalised).digest('hex');
  }

  email(value: string | null | undefined): string | null {
    if (!value?.trim()) return null;
    return this.digest(`email:${BlindIndexService.normaliseEmail(value)}`);
  }

  phone(value: string | null | undefined): string | null {
    if (!value?.trim()) return null;
    const normalised = BlindIndexService.normalisePhone(value);
    // A "phone" with no digits indexes to nothing rather than to the digest of
    // an empty string, which every other blank would also match.
    return normalised ? this.digest(`phone:${normalised}`) : null;
  }
}
