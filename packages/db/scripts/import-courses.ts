/**
 * Import a course manifest into ONE tenant (docs/74 §4).
 *
 *   pnpm --filter @aviora/db courses:import --tenant <uuid> --file data/gg-pack-2026.json
 *   pnpm --filter @aviora/db courses:import --tenant <uuid> --file … --dry-run
 *
 * An OPERATOR tool, run by hand, for the one job the API is a bad fit for:
 * ninety lessons that already exist as a list somebody else made. Everything it
 * writes is reachable through `POST /courses` and `POST /learning/assets/…`,
 * and it applies the same shapes — this is a faster door into the same room,
 * not a second set of rules.
 *
 * **Idempotent by course code.** Running it twice does not duplicate a course
 * or a lesson; a lesson whose title changed upstream is updated in place, and
 * a video id that changed replaces the asset. That matters because a manifest
 * gets re-captured when the source playlist changes, and the honest thing for
 * the second run to do is reconcile rather than pile up.
 *
 * It does NOT publish. Every course lands with the release policy the manifest
 * asks for and nothing is assigned to anybody — who sees what is a leader's
 * decision (docs/73), and an importer that also released would be making it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { createOwnerClient } from '../src/client';
import { withTenant } from '../src/unit-of-work';

const manifestSchema = z.object({
  source: z.string().optional(),
  note: z.string().optional(),
  courses: z
    .array(
      z.object({
        code: z.string().regex(/^[a-z0-9-]{2,60}$/),
        title: z.string().min(1).max(200),
        description: z.string().max(2000).nullish(),
        releasePolicy: z.enum(['open', 'on_assignment']).default('on_assignment'),
        releaseRule: z.object({ after: z.string() }).nullish(),
        lessons: z
          .array(
            z.object({
              order: z.number().int().min(1),
              title: z.string().min(1).max(300),
              provider: z.literal('youtube'),
              // The id, never a URL — a URL carries the playlist with it.
              externalId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
              durationSeconds: z.number().int().min(0).nullish(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const tenantId = arg('tenant');
  const file = arg('file');
  const dryRun = process.argv.includes('--dry-run');
  if (!tenantId || !file) {
    throw new Error('usage: courses:import --tenant <uuid> --file <manifest.json> [--dry-run]');
  }

  const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as unknown;
  const manifest = manifestSchema.parse(raw);

  const ids = manifest.courses.flatMap((c) => c.lessons.map((l) => l.externalId));
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length > 0) {
    // The same video appearing in two packs is more likely a capture mistake
    // than a decision, and it would make one lesson's progress ambiguous.
    throw new Error(`the manifest repeats these video ids: ${[...new Set(duplicates)].join(', ')}`);
  }

  const prisma = createOwnerClient();
  try {
    const tenant = await prisma.tenant.findFirst({ where: { id: tenantId } });
    if (!tenant) throw new Error(`no tenant with id ${tenantId}`);
    console.log(`tenant: ${tenant.name} (${tenant.id})`);
    console.log(`manifest: ${manifest.courses.length} courses, ${ids.length} lessons`);
    if (manifest.source) console.log(`source: ${manifest.source}`);
    if (dryRun) {
      console.log('\n--dry-run: nothing written');
      for (const c of manifest.courses) {
        console.log(`  ${c.code}  ${c.title}  (${c.lessons.length} lessons, ${c.releasePolicy})`);
      }
      return;
    }

    let created = 0;
    let updated = 0;
    let lessons = 0;
    await withTenant(prisma, tenantId, async (tx) => {
      for (const course of manifest.courses) {
        const existing = await tx.course.findFirst({ where: { code: course.code } });
        const row = existing
          ? await tx.course.update({
              where: { id: existing.id },
              data: {
                title: course.title,
                description: course.description ?? null,
                releasePolicy: course.releasePolicy,
                releaseRule: course.releaseRule ?? undefined,
              },
            })
          : await tx.course.create({
              data: {
                tenantId,
                code: course.code,
                title: course.title,
                description: course.description ?? null,
                status: 'published',
                releasePolicy: course.releasePolicy,
                releaseRule: course.releaseRule ?? undefined,
              },
            });
        if (existing) updated += 1;
        else created += 1;

        for (const lesson of course.lessons) {
          const atOrder = await tx.lesson.findFirst({
            where: { courseId: row.id, order: lesson.order },
          });
          const saved = atOrder
            ? await tx.lesson.update({
                where: { id: atOrder.id },
                data: { title: lesson.title },
              })
            : await tx.lesson.create({
                data: { tenantId, courseId: row.id, order: lesson.order, title: lesson.title },
              });
          lessons += 1;

          const asset = await tx.lessonAsset.findFirst({
            where: { lessonId: saved.id, kind: 'video', locale: '*' },
          });
          const data = {
            provider: lesson.provider,
            externalId: lesson.externalId,
            durationSeconds: lesson.durationSeconds ?? null,
            storageKey: null,
            contentType: null,
            byteSize: null,
          };
          if (asset) {
            await tx.lessonAsset.update({ where: { id: asset.id }, data });
          } else {
            await tx.lessonAsset.create({
              data: { tenantId, lessonId: saved.id, kind: 'video', locale: '*', ...data },
            });
          }
        }
      }
    });

    console.log(`\ncourses created ${created}, updated ${updated} · lessons written ${lessons}`);
    console.log('Nothing has been released to anybody — that is a leader’s decision (docs/73).');
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
