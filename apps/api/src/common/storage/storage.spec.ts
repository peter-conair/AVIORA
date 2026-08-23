/**
 * The refusal, watched firing (docs/65 §4.1).
 *
 * Booting production on local disk works perfectly — right up to the first
 * redeploy, when photographs customers consented to give exactly once are gone
 * and nobody finds out until somebody asks for their before picture.
 */
import { describe, expect, it } from 'vitest';
import { selectStorage } from './storage.module';
import type { StoragePort } from './storage.port';

const nonDurable = { name: 'local-disk', durable: false } as StoragePort;
const durable = { name: 'r2', durable: true } as StoragePort;

describe('choosing an object store', () => {
  it('allows a non-durable store outside production', () => {
    expect(selectStorage(nonDurable, { NODE_ENV: 'development' })).toBe(nonDurable);
    expect(selectStorage(nonDurable, { NODE_ENV: 'test' })).toBe(nonDurable);
  });

  it.each([
    ['NODE_ENV', { NODE_ENV: 'production' }],
    ['BACKEND_ENV', { BACKEND_ENV: 'prod' }],
  ])('refuses a non-durable store when %s says production', (_label, env) => {
    // Failing at startup is by a wide margin the kinder failure: the alternative
    // is silent data loss discovered months later by a customer.
    expect(() => selectStorage(nonDurable, env)).toThrow(/durable object storage/i);
  });

  it('allows a durable store in production', () => {
    expect(selectStorage(durable, { NODE_ENV: 'production' })).toBe(durable);
  });
});
