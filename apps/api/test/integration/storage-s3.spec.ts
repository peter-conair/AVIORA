/**
 * The S3 adapter, against a real object store (docs/71 §4).
 *
 * A mock of an object store proves that the code calls the methods it calls.
 * What matters here is the parts a mock has no opinion about: that a missing
 * key comes back as `null` rather than as an exception, that a delete of
 * something already gone still succeeds — consent withdrawal depends on it —
 * and that the bytes returned are the bytes stored, which is the entire promise
 * being made about a customer's photograph.
 *
 * It skips when no bucket is configured. CI configures one (a MinIO service
 * container) precisely so it does not skip there: a suite that passes by never
 * running is the failure mode this codebase keeps finding.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3Adapter, s3ConfigFromEnv } from '../../src/common/storage/s3.adapter';

const config = s3ConfigFromEnv(process.env);
const run = config ? describe : describe.skip;

run('S3-compatible object storage', () => {
  const adapter = new S3Adapter(config!);
  const prefix = `test/${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const keys: string[] = [];
  const key = (name: string) => {
    const k = `${prefix}/${name}`;
    keys.push(k);
    return k;
  };

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);

  beforeAll(async () => {
    await adapter.verify();
  });

  afterAll(async () => {
    await Promise.allSettled(keys.map((k) => adapter.delete(k)));
  });

  it('reaches the bucket and reports itself durable', () => {
    expect(adapter.durable).toBe(true);
    expect(adapter.name).toContain(config!.bucket);
  });

  it('returns the bytes that were stored, and the content type with them', async () => {
    const k = key('round-trip');
    await adapter.put({ key: k, body: png, contentType: 'image/png' });
    const got = await adapter.get(k);
    expect(got?.body.equals(png)).toBe(true);
    // The type travels with the object because the download endpoint sends it
    // straight to a browser; guessing there would mean serving a photograph as
    // application/octet-stream and offering it as a download.
    expect(got?.contentType).toBe('image/png');
  });

  it('answers null for a key that is not there', async () => {
    // Not an exception. The caller turns this into a 404, and an adapter that
    // threw would make every missing photo a 500.
    expect(await adapter.get(`${prefix}/never-written`)).toBeNull();
  });

  it('deletes, and a second delete still succeeds', async () => {
    const k = key('deleted');
    await adapter.put({ key: k, body: png, contentType: 'image/png' });
    await adapter.delete(k);
    expect(await adapter.get(k)).toBeNull();
    // Withdrawing consent must not fail because somebody already tidied up.
    await expect(adapter.delete(k)).resolves.toBeUndefined();
  });

  it('keeps keys apart by tenant path', async () => {
    // The key convention is tenants/{id}/... (docs/18 §2). Nothing enforces it
    // in the store, so what this checks is that a path with slashes survives a
    // round trip rather than being flattened or rejected.
    const a = key('tenants/tenant-a/customers/c1/photo');
    const b = key('tenants/tenant-b/customers/c1/photo');
    await adapter.put({ key: a, body: Buffer.from('A'), contentType: 'text/plain' });
    await adapter.put({ key: b, body: Buffer.from('B'), contentType: 'text/plain' });
    expect((await adapter.get(a))?.body.toString()).toBe('A');
    expect((await adapter.get(b))?.body.toString()).toBe('B');
  });

  it('refuses a bucket that does not exist', async () => {
    const wrong = new S3Adapter({ ...config!, bucket: `${config!.bucket}-does-not-exist` });
    // This is the check that runs at boot. If it passed against a missing
    // bucket it would be a startup control that never fires.
    await expect(wrong.verify()).rejects.toThrow();
  });
});
