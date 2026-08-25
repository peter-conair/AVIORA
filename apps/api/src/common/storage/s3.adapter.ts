import { Logger } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import type { StoragePort, StoredObject, StoredRange } from './storage.port';

/**
 * S3-compatible object storage (docs/71).
 *
 * One adapter serves MinIO, Cloudflare R2 and AWS S3, because all three speak
 * the same API. That is the whole reason to start on a MinIO container: moving
 * to R2 later is a change of four environment variables and a copy of the
 * objects, not a second implementation and a second set of bugs.
 *
 * There are no signed URLs here and there should not be. Bytes are read through
 * the API, which is where the consent check lives — a URL that works without
 * passing through this codebase is a photograph with no access control on it,
 * and choosing a short expiry does not change that.
 */
export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** For logs: which kind of endpoint this turned out to be. */
  flavour: 'r2' | 's3';
}

/** Variables that must arrive together; naming them makes the error useful. */
const REQUIRED = [
  'AVIORA_S3_BUCKET',
  'AVIORA_S3_ACCESS_KEY_ID',
  'AVIORA_S3_SECRET_ACCESS_KEY',
] as const;

/**
 * Reads the storage configuration, or returns null when none is present.
 *
 * **A PARTIAL configuration throws.** The tempting alternative — treat
 * incomplete settings as "not configured" and fall back to local disk — turns a
 * typo in a bucket name into either silent data loss outside production or, in
 * production, a refusal that names durability and never mentions the typo.
 * Somebody would read that message and go looking for a missing adapter that
 * was in fact right there.
 */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv): S3Config | null {
  // R2 is addressed by account id rather than by hostname, so one variable
  // stands in for the endpoint. An explicit endpoint always wins, which is what
  // makes MinIO and a local test bucket possible.
  const accountId = env.AVIORA_R2_ACCOUNT_ID?.trim();
  const explicit = env.AVIORA_S3_ENDPOINT?.trim();
  const endpoint = explicit || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');

  const present = REQUIRED.filter((key) => (env[key] ?? '').trim() !== '');
  if (!endpoint && present.length === 0) return null;

  const missing = [
    ...(endpoint ? [] : ['AVIORA_S3_ENDPOINT (or AVIORA_R2_ACCOUNT_ID)']),
    ...REQUIRED.filter((key) => (env[key] ?? '').trim() === ''),
  ];
  if (missing.length > 0) {
    throw new Error(
      `Object storage is partly configured — missing ${missing.join(', ')}. ` +
        'Set all of them, or none of them to use local disk outside production.',
    );
  }

  const flavour: S3Config['flavour'] = endpoint.includes('r2.cloudflarestorage.com') ? 'r2' : 's3';
  return {
    endpoint,
    // R2 has exactly one region and calls it `auto`; MinIO ignores the value but
    // the SDK refuses to sign a request without one.
    region: env.AVIORA_S3_REGION?.trim() || 'auto',
    bucket: (env.AVIORA_S3_BUCKET ?? '').trim(),
    accessKeyId: (env.AVIORA_S3_ACCESS_KEY_ID ?? '').trim(),
    secretAccessKey: (env.AVIORA_S3_SECRET_ACCESS_KEY ?? '').trim(),
    // Virtual-host style needs per-bucket DNS, which a MinIO container does not
    // have. Path style works everywhere including R2, so it is the default.
    forcePathStyle: (env.AVIORA_S3_FORCE_PATH_STYLE ?? 'true').trim() !== 'false',
    flavour,
  };
}

export class S3Adapter implements StoragePort {
  readonly name: string;
  readonly durable = true;
  private readonly logger = new Logger(S3Adapter.name);
  private readonly client: S3Client;

  constructor(private readonly config: S3Config) {
    this.name = `${config.flavour}:${config.bucket}`;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  /**
   * Prove the bucket is reachable and the credential works.
   *
   * Without this the first sign of a wrong key is a customer's upload failing,
   * after they have been asked to undress and take a photograph. A HEAD at boot
   * costs one request and moves that failure to a deploy log.
   */
  async verify(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
  }

  async put(input: { key: string; body: Buffer; contentType: string }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
      }),
    );
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      if (!out.Body) return null;
      const bytes = await out.Body.transformToByteArray();
      return {
        body: Buffer.from(bytes),
        contentType: out.ContentType ?? 'application/octet-stream',
      };
    } catch (err) {
      // A missing object is an answer, not a failure — the caller turns it into
      // a 404. Anything else is a real fault and must not be flattened into
      // "no photo here", which would read to a customer as a deleted picture.
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * A ranged GET, passed straight through to the store (docs/73 §7).
   *
   * S3, R2 and MinIO all implement `Range` themselves, so this adapter does no
   * slicing — it asks for the bytes it wants and hands back the stream. The
   * total length comes from `Content-Range` when a range was served and from
   * `Content-Length` when the whole object was, because a ranged response's
   * `Content-Length` is the length of the SLICE and using it as the total would
   * tell every player the file is as long as whatever piece it just asked for.
   */
  async getRange(
    key: string,
    range?: { start: number; end?: number },
  ): Promise<StoredRange | null> {
    const header =
      range === undefined
        ? undefined
        : `bytes=${range.start}-${range.end === undefined ? '' : range.end}`;
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key, Range: header }),
      );
      if (!out.Body) return null;
      const contentLength = out.ContentLength ?? 0;
      return {
        stream: out.Body as Readable,
        contentType: out.ContentType ?? 'application/octet-stream',
        contentLength,
        totalLength: totalFrom(out.ContentRange) ?? contentLength,
      };
    } catch (err) {
      // 416 means the range was past the end of the object. Treated as "no
      // answer" so the controller can reply 416 from one place rather than
      // every adapter inventing its own error shape.
      if (isNotFound(err) || isRangeNotSatisfiable(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    // S3 deletes are idempotent and a missing key succeeds. That is the
    // behaviour consent withdrawal needs: the desired end state is absence.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
    this.logger.debug(`deleted ${key}`);
  }
}

/** S3 says NoSuchKey, R2 and MinIO sometimes answer a bare 404. */
export function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

/** `bytes 0-1023/48000` → 48000. */
export function totalFrom(contentRange: string | undefined): number | null {
  const total = contentRange?.split('/')[1];
  if (!total || total === '*') return null;
  const parsed = Number(total);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isRangeNotSatisfiable(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'InvalidRange' || e?.$metadata?.httpStatusCode === 416;
}
