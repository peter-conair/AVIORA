/**
 * Object storage, as a port (docs/65 §4).
 *
 * The same shape as the AI gateway's `provider.port.ts`: one interface, an
 * adapter per backing store, and nothing above this line knows which is in use.
 *
 * Keys are opaque and returned by `put`. Callers never construct one and never
 * receive a URL — **a URL that works without passing through this API is a
 * photograph with no access control on it**, and no amount of guessing at
 * expiry times fixes that.
 */
export interface StoredObject {
  body: Buffer;
  contentType: string;
}

export interface StoragePort {
  /** Human-readable, for logs and the health endpoint. */
  readonly name: string;
  /** True when this adapter is safe to hold real customer data. */
  readonly durable: boolean;
  put(input: { key: string; body: Buffer; contentType: string }): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

export const STORAGE_PORT = Symbol('STORAGE_PORT');
