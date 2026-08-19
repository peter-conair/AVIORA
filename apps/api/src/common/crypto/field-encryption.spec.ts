import { beforeEach, describe, expect, it } from 'vitest';
import { FieldEncryptionService } from './field-encryption.service';

const KEY = Buffer.alloc(32, 3).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');

describe('FieldEncryptionService', () => {
  let svc: FieldEncryptionService;

  beforeEach(() => {
    process.env.AVIORA_PII_ENCRYPTION_KEY = KEY;
    svc = new FieldEncryptionService();
  });

  it('round-trips a value', () => {
    const stored = svc.encrypt('sleeps badly on work nights');
    expect(stored).toMatch(/^enc\.v1\./);
    expect(stored).not.toContain('sleeps badly');
    expect(svc.decrypt(stored)).toBe('sleeps badly on work nights');
  });

  it('produces a different ciphertext each time (random IV)', () => {
    expect(svc.encrypt('same')).not.toBe(svc.encrypt('same'));
  });

  it('treats empty input as absent', () => {
    expect(svc.encrypt('')).toBeNull();
    expect(svc.encrypt(null)).toBeNull();
    expect(svc.decrypt(null)).toBeNull();
  });

  it('reads plaintext written before encryption existed', () => {
    expect(svc.decrypt('an old plain note')).toBe('an old plain note');
  });

  it('fails closed when no key is configured', () => {
    delete process.env.AVIORA_PII_ENCRYPTION_KEY;
    expect(() => new FieldEncryptionService().encrypt('secret')).toThrow(/not configured/i);
  });

  it('refuses to silently return garbage under a wrong key', () => {
    const stored = svc.encrypt('secret')!;
    process.env.AVIORA_PII_ENCRYPTION_KEY = OTHER_KEY;
    expect(() => new FieldEncryptionService().decrypt(stored)).toThrow(/wrong key|corrupted/i);
  });

  it('rejects a key that is not 32 bytes', () => {
    process.env.AVIORA_PII_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString('base64');
    expect(() => new FieldEncryptionService().encrypt('x')).toThrow(/32 bytes/i);
  });
});
