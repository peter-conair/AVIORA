import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ERROR_CODES, newId } from '@aviora/shared';
import type { Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import {
  STORAGE_PORT,
  type StoragePort,
  type StoredRange,
} from '../../common/storage/storage.port';
import { parseRangeHeader, type RangeRequest } from '../../common/storage/range';
import { LearningReleaseService, type Lock } from './learning-release.service';

/**
 * 200 MB. Roughly twenty minutes of 720p, which is longer than any single
 * training video should be anyway.
 *
 * The number is a memory budget rather than a quality judgement: the body is
 * buffered (docs/73 §7), so this is what one concurrent upload costs the API.
 * Raising it without moving to multipart streaming raises that cost linearly.
 */
export const MAX_LESSON_ASSET_BYTES = 200 * 1024 * 1024;

export const ASSET_KINDS = ['video', 'captions', 'thumbnail'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** `*` serves every locale — a thumbnail, usually. */
export const ANY_LOCALE = '*';

export interface UploadAssetInput {
  lessonId: string;
  kind: AssetKind;
  locale: string;
  contentType: string;
  body: Buffer;
  durationSeconds?: number | null;
}

/**
 * Lesson media: storing it, and serving the bytes (docs/73 §6–§7).
 *
 * Nothing here decides who may watch. That is `LearningReleaseService`, called
 * before a byte is read, so there is one answer to "may this member see this
 * course" and this file is not a second one.
 */
@Injectable()
export class LearningMediaService {
  constructor(
    private readonly db: TenantDb,
    private readonly release: LearningReleaseService,
    private readonly audit: AuditService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  /** Author-side. Replaces the asset of the same (lesson, kind, locale). */
  async upload(input: UploadAssetInput) {
    if (input.body.byteLength === 0 || input.body.byteLength > MAX_LESSON_ASSET_BYTES) {
      throw new PayloadTooLargeException({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `A lesson asset must be between 1 byte and ${MAX_LESSON_ASSET_BYTES} bytes`,
      });
    }
    const asset = await this.db.tx(async (tx) => {
      const lesson = await tx.lesson.findFirst({
        where: { id: input.lessonId },
        select: { id: true },
      });
      if (!lesson) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Lesson not found' });
      }

      const existing = await tx.lessonAsset.findFirst({
        where: { lessonId: input.lessonId, kind: input.kind, locale: input.locale },
      });

      const storageKey = `tenants/${this.db.tenantId}/lessons/${input.lessonId}/${newId()}`;
      // Written before the row, so a failed upload leaves no row pointing at
      // nothing. The reverse order leaves a lesson that looks playable and is
      // not, which is discovered by a member rather than by this function.
      await this.storage.put({
        key: storageKey,
        body: input.body,
        contentType: input.contentType,
      });

      const saved = existing
        ? await tx.lessonAsset.update({
            where: { id: existing.id },
            data: {
              storageKey,
              contentType: input.contentType,
              byteSize: input.body.byteLength,
              durationSeconds: input.durationSeconds ?? null,
            },
          })
        : await tx.lessonAsset.create({
            data: {
              tenantId: this.db.tenantId,
              lessonId: input.lessonId,
              kind: input.kind,
              locale: input.locale,
              storageKey,
              contentType: input.contentType,
              byteSize: input.body.byteLength,
              durationSeconds: input.durationSeconds ?? null,
            },
          });

      // The replaced object is dropped only after the row points at the new
      // one. Best-effort: an orphan in the bucket costs storage, a missing
      // object costs a lesson.
      if (existing && existing.storageKey !== storageKey) {
        await this.storage.delete(existing.storageKey).catch(() => undefined);
      }
      return saved;
    });

    // Rare, and it changes what every member of the tenant sees. Replacing a
    // video in place leaves no other trace — the row keeps one storage key and
    // the old object is gone — so without this there would be no record that
    // the lesson somebody watched last week is not the one there now.
    await this.audit.record({
      action: 'learning.asset.upload',
      entityType: 'lesson',
      entityId: input.lessonId,
      after: { kind: input.kind, locale: input.locale, byteSize: input.body.byteLength },
    });
    return asset;
  }

  /**
   * The asset a member is allowed to play, or the reason they are not.
   *
   * A locked lesson answers **403 with the lock**, not 404. docs/37 §4 answers
   * 404 for another team's article, because confirming it exists is itself
   * information about that team — but this is the member's own curriculum, held
   * by their own upline, and pretending it does not exist is the behaviour
   * docs/73 §5 exists to prevent.
   */
  async assetFor(memberId: string | null, lessonId: string, kind: AssetKind, locale: string) {
    return this.db.tx(async (tx) => {
      const lesson = await tx.lesson.findFirst({
        where: { id: lessonId },
        select: {
          id: true,
          course: {
            select: { id: true, code: true, status: true, releasePolicy: true, releaseRule: true },
          },
        },
      });
      if (!lesson || lesson.course.status !== 'published') {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Lesson not found' });
      }
      if (!memberId) {
        throw new ForbiddenException({
          code: ERROR_CODES.FORBIDDEN,
          message: 'You are not a member of this tenant',
        });
      }

      const release = await this.release.forOne(tx, memberId, lesson.course);
      if (!release.visible) {
        throw new ForbiddenException({
          code: ERROR_CODES.FORBIDDEN,
          message: lockMessage(release.lock),
          lock: release.lock,
        });
      }

      return this.pickAsset(tx, lessonId, kind, locale);
    });
  }

  /**
   * Exact locale first, then the `*` fallback. A Thai learner with no Thai
   * captions is better served the English ones than nothing; a learner given
   * silently the wrong language would not know why it looked odd, so the
   * response says which locale it actually served.
   */
  private async pickAsset(tx: Tx, lessonId: string, kind: AssetKind, locale: string) {
    const candidates = await tx.lessonAsset.findMany({
      where: { lessonId, kind, locale: { in: [locale, ANY_LOCALE] } },
    });
    const asset =
      candidates.find((a) => a.locale === locale) ??
      candidates.find((a) => a.locale === ANY_LOCALE) ??
      null;
    if (!asset) {
      throw new NotFoundException({
        code: ERROR_CODES.NOT_FOUND,
        message: `This lesson has no ${kind}`,
      });
    }
    return asset;
  }

  /**
   * Open the bytes for a request, honouring `Range`.
   *
   * The range is parsed against the size RECORDED AT UPLOAD rather than against
   * whatever the store reports, so a suffix range resolves the same way on
   * every adapter. The `Content-Range` denominator then comes back from the
   * store itself, which is the number the player must be told.
   */
  async open(
    asset: { storageKey: string; byteSize: number; contentType: string },
    rangeHeader: string | undefined,
  ): Promise<{ request: RangeRequest; body: StoredRange | null }> {
    const request = parseRangeHeader(rangeHeader, asset.byteSize);
    if (request.kind === 'unsatisfiable') return { request, body: null };

    if (!this.storage.getRange) {
      // Falling back to a buffered read would work and would also mean no
      // seeking and no iOS playback, silently. Better to say which adapter
      // cannot do the job.
      throw new NotFoundException({
        code: ERROR_CODES.NOT_FOUND,
        message: `The configured object store (${this.storage.name}) cannot serve byte ranges`,
      });
    }
    const body = await this.storage.getRange(
      asset.storageKey,
      request.kind === 'range' ? request.range : undefined,
    );
    return { request, body };
  }

  /**
   * Record how far through a lesson somebody is.
   *
   * `watchedDeltaSeconds` ACCUMULATES and `positionSeconds` overwrites, which is
   * the whole reason there are two columns (docs/73 §6). A player that seeks
   * moves the position and adds nothing to the watched total, so dragging to
   * the end does not finish a lesson.
   */
  async recordProgress(
    memberId: string,
    lessonId: string,
    input: { positionSeconds: number; watchedDeltaSeconds: number },
  ) {
    return this.db.tx(async (tx) => {
      const lesson = await tx.lesson.findFirst({
        where: { id: lessonId },
        select: { id: true },
      });
      if (!lesson) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Lesson not found' });
      }
      const existing = await tx.lessonView.findFirst({ where: { memberId, lessonId } });
      if (!existing) {
        return tx.lessonView.create({
          data: {
            tenantId: this.db.tenantId,
            memberId,
            lessonId,
            positionSeconds: input.positionSeconds,
            watchedSeconds: input.watchedDeltaSeconds,
          },
        });
      }
      return tx.lessonView.update({
        where: { id: existing.id },
        data: {
          positionSeconds: input.positionSeconds,
          watchedSeconds: existing.watchedSeconds + input.watchedDeltaSeconds,
        },
      });
    });
  }
}

/** Plain language, because a member reads this and not only a developer. */
export function lockMessage(lock: Lock): string {
  switch (lock.state) {
    case 'awaiting_rule':
      return `This lesson opens after ${lock.after}`;
    case 'held':
      return `Your upline has not opened this lesson yet: ${lock.reason}`;
    case 'awaiting_leader':
      return 'Your upline has not opened this lesson yet';
    default:
      return 'This lesson is not open to you';
  }
}
