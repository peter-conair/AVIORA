/**
 * Fetch the catalogue's pictures and keep our own copy (docs/74 §7).
 *
 * The ingest records a URL on somebody else's CDN. That is the right thing for
 * the ingest to do — it takes a catalogue, not an upload — and the wrong thing
 * to depend on forever: the day that CDN moves, every product in this platform
 * loses its picture at once, and nobody finds out from a log.
 *
 * So this is a job somebody RUNS, on purpose, having decided that fetching a
 * few thousand files from a third party is a thing they want to do. It is not
 * on a schedule and nothing calls it.
 *
 * Idempotent and resumable: it only looks at rows with no `stored_path`, and it
 * keys objects by a digest of the URL, so a second run after a half-finished
 * first one picks up exactly what is missing. The same picture used by two
 * products is fetched ONCE and both rows point at it.
 *
 *   pnpm --filter @aviora/api mirror:product-images
 *   pnpm --filter @aviora/api mirror:product-images -- --limit 50
 */
import { createHash } from 'node:crypto';
import { createOwnerClient } from '@aviora/db';
import { LocalDiskAdapter } from '../src/common/storage/local-disk.adapter';
import { buildStorage } from '../src/common/storage/storage.module';

/** Politeness, not throughput. Somebody else pays for these bytes. */
const CONCURRENCY = 6;
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 8 * 1024 * 1024;
const ATTEMPTS = 2;

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Fetched {
  body: Buffer;
  contentType: string;
}

async function fetchImage(url: string): Promise<Fetched | string> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const abort = AbortSignal.timeout(TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: abort, redirect: 'follow' });
      if (!res.ok) {
        // 4xx is the answer, not a hiccup: retrying a 404 wastes their server
        // and ours. Only a 5xx or a dropped connection is worth a second go.
        if (res.status < 500) return `HTTP ${res.status}`;
        if (attempt === ATTEMPTS) return `HTTP ${res.status}`;
        continue;
      }
      const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
      if (!EXT[contentType]) return `not an image (${contentType || 'no content-type'})`;
      const body = Buffer.from(await res.arrayBuffer());
      if (body.byteLength === 0) return 'empty body';
      if (body.byteLength > MAX_BYTES) return `${body.byteLength} bytes is over the cap`;
      return { body, contentType };
    } catch (e) {
      if (attempt === ATTEMPTS) return e instanceof Error ? e.message : String(e);
    }
  }
  return 'unreachable';
}

async function main(): Promise<void> {
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const prisma = createOwnerClient();
  // The SAME selection the API makes, imported rather than re-implemented: a
  // job that writes somewhere the API does not read is a job that appears to
  // work and produces nothing anybody can see.
  const storage = buildStorage(new LocalDiskAdapter(), process.env);
  console.log(`store: ${storage.name}${storage.durable ? '' : ' (NOT durable)'}`);

  try {
    const rows = await prisma.productImage.findMany({
      where: { storedPath: null },
      select: { id: true, url: true },
      orderBy: { url: 'asc' },
      ...(limit ? { take: limit } : {}),
    });
    if (rows.length === 0) {
      console.log('nothing to mirror — every image already has a copy');
      return;
    }

    // Group by URL first. Two products sharing a picture is common in a
    // catalogue, and fetching it twice is somebody else's bandwidth wasted.
    const byUrl = new Map<string, string[]>();
    for (const row of rows) {
      const ids = byUrl.get(row.url) ?? [];
      ids.push(row.id);
      byUrl.set(row.url, ids);
    }
    const urls = [...byUrl.keys()];
    console.log(`${rows.length} rows · ${urls.length} distinct pictures to fetch`);

    let done = 0;
    let stored = 0;
    let failed = 0;
    const failures: Array<{ url: string; why: string }> = [];

    const worker = async (): Promise<void> => {
      for (;;) {
        const url = urls.pop();
        if (!url) return;
        const got = await fetchImage(url);
        done++;
        if (typeof got === 'string') {
          failed++;
          failures.push({ url, why: got });
        } else {
          const digest = createHash('sha256').update(url).digest('hex').slice(0, 32);
          const key = `catalog/products/${digest}.${EXT[got.contentType]}`;
          await storage.put({ key, body: got.body, contentType: got.contentType });
          await prisma.productImage.updateMany({
            where: { id: { in: byUrl.get(url)! } },
            data: { storedPath: key },
          });
          stored += byUrl.get(url)!.length;
        }
        if (done % 100 === 0) console.log(`  ${done}/${done + urls.length} · ${failed} failed`);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    console.log(`\nmirrored ${stored} rows · ${failed} pictures could not be fetched`);
    // Named, not counted: a failure nobody can look up is a failure nobody
    // fixes, and re-running only retries what is still missing anyway.
    for (const f of failures.slice(0, 20)) console.log(`  ${f.why} — ${f.url}`);
    if (failures.length > 20) console.log(`  … and ${failures.length - 20} more`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
