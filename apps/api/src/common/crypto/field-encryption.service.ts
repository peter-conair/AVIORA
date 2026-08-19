import * as crypto from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const PREFIX = 'enc.v1';

/**
 * Field-level encryption for sensitive free text (docs/13 §encryption).
 *
 * Fail-closed by design: if no key is configured, writing a sensitive field
 * throws rather than silently storing plaintext. Reading tolerates plaintext
 * so a database written before the key existed stays readable.
 *
 * Format: enc.v1.<iv-b64>.<tag-b64>.<ciphertext-b64>
 */
@Injectable()
export class FieldEncryptionService {
  private readonly logger = new Logger(FieldEncryptionService.name);

  private key(): Buffer | null {
    const raw = process.env.AVIORA_PII_ENCRYPTION_KEY;
    if (!raw) return null;
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error('AVIORA_PII_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
    }
    return key;
  }

  get isConfigured(): boolean {
    return !!process.env.AVIORA_PII_ENCRYPTION_KEY;
  }

  encrypt(plaintext: string | null | undefined): string | null {
    if (plaintext === null || plaintext === undefined || plaintext === '') return null;
    const key = this.key();
    if (!key) {
      // fail closed: never write sensitive text unprotected
      throw new Error(
        'AVIORA_PII_ENCRYPTION_KEY is not configured; refusing to store sensitive data',
      );
    }
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      PREFIX,
      iv.toString('base64'),
      tag.toString('base64'),
      ciphertext.toString('base64'),
    ].join('.');
  }

  decrypt(stored: string | null | undefined): string | null {
    if (!stored) return null;
    if (!stored.startsWith(`${PREFIX}.`)) return stored; // written before encryption existed
    const key = this.key();
    if (!key) {
      this.logger.warn('encrypted field read without a key configured');
      return null;
    }
    // the prefix itself contains a dot ("enc.v1"), so the payload starts at 2
    const [, , ivB64, tagB64, dataB64] = stored.split('.');
    if (!ivB64 || !tagB64 || !dataB64) {
      throw new Error('Unable to decrypt field: malformed value');
    }
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64!, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64!, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(dataB64!, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // a wrong or rotated key must not look like empty data
      throw new Error('Unable to decrypt field: wrong key or corrupted value');
    }
  }
}
