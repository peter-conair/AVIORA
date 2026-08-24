import type { Readable } from 'node:stream';

/**
 * Object storage, as a port (docs/65 §4, docs/73 §7).
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

/**
 * A byte range, streamed rather than buffered (docs/73 §7).
 *
 * `get` returns a Buffer, which is right for a photograph and wrong for video
 * twice over: a 200 MB file per concurrent viewer held in the API's memory, and
 * no way to answer a partial request. The second one is not a performance note
 * — **iOS Safari will not play a `<video>` from a server that does not answer
 * Range requests**, so on the phone this product is actually used on
 * (docs/72), buffering is the feature not working.
 */
export interface StoredRange {
  stream: Readable;
  contentType: string;
  /** Bytes in THIS response — what goes in `Content-Length`. */
  contentLength: number;
  /** Bytes in the whole object — the denominator of `Content-Range`. */
  totalLength: number;
}

export interface StoragePort {
  /** Human-readable, for logs and the health endpoint. */
  readonly name: string;
  /** True when this adapter is safe to hold real customer data. */
  readonly durable: boolean;
  put(input: { key: string; body: Buffer; contentType: string }): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  /**
   * Stream part of an object. `end` is INCLUSIVE, as HTTP means it.
   *
   * Optional so an adapter may be added without it, but every adapter that
   * backs video needs it — `StorageModule` is where a store without it should
   * be refused for that job rather than silently buffering the whole file.
   *
   * Returns null for a missing object, the same answer `get` gives, so the
   * caller turns both into one 404.
   */
  getRange?(key: string, range?: { start: number; end?: number }): Promise<StoredRange | null>;
  delete(key: string): Promise<void>;
  /**
   * Prove the backing store is reachable and the credential works.
   *
   * Optional because a local directory has nothing to prove. For a remote
   * bucket it is the difference between learning about a wrong key from a
   * deploy log and learning about it from a customer whose upload failed after
   * they had already undressed and taken the photograph.
   */
  verify?(): Promise<void>;
}

export const STORAGE_PORT = Symbol('STORAGE_PORT');
