import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { ENTITLEMENTS, ERROR_CODES, PERMISSIONS } from '@aviora/shared';
import { RequireEntitlements, RequirePermissions } from '../../common/auth/decorators';
import { CLS_MEMBER_ID } from '../../common/auth/permissions.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import {
  ANY_LOCALE,
  ASSET_KINDS,
  LearningMediaService,
  YOUTUBE_ID,
} from './learning-media.service';

const assetQuerySchema = z.object({
  lessonId: z.string().uuid(),
  kind: z.enum(ASSET_KINDS),
  locale: z
    .string()
    .regex(/^(th|en|\*)$/)
    .default(ANY_LOCALE),
  durationSeconds: z.coerce.number().int().min(0).max(86_400).optional(),
});

const externalSchema = z.object({
  lessonId: z.string().uuid(),
  kind: z.enum(ASSET_KINDS).default('video'),
  locale: z
    .string()
    .regex(/^(th|en|\*)$/)
    .default(ANY_LOCALE),
  provider: z.literal('youtube'),
  /** The id, never a URL — a URL carries the playlist id with it (docs/74 §3). */
  externalId: z.string().regex(YOUTUBE_ID),
  durationSeconds: z.number().int().min(0).max(86_400).nullish(),
});

const playQuerySchema = z.object({
  kind: z.enum(ASSET_KINDS).default('video'),
  locale: z
    .string()
    .regex(/^(th|en)$/)
    .default('th'),
});

const progressSchema = z.object({
  positionSeconds: z.number().int().min(0).max(86_400),
  /**
   * Seconds of playback SINCE the last report, not a running total. The client
   * cannot inflate the total by replaying an old number, and a dropped
   * heartbeat costs those seconds rather than corrupting the tally.
   */
  watchedDeltaSeconds: z.number().int().min(0).max(600),
});

@Controller()
export class LearningMediaController {
  constructor(
    private readonly media: LearningMediaService,
    private readonly cls: ClsService,
  ) {}

  private memberId(): string | null {
    return (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null;
  }

  /**
   * Upload a lesson's video, captions or thumbnail.
   *
   * The body is raw bytes and the `Content-Type` header is the asset's own type
   * — no base64, no multipart, no envelope. `app.factory` mounts the raw parser
   * on this one path so the rest of the API keeps its small body limit.
   */
  @Post('learning/assets')
  @RequirePermissions(PERMISSIONS.LEARNING_MANAGE)
  async upload(
    @Query(new ZodPipe(assetQuerySchema)) query: z.infer<typeof assetQuerySchema>,
    @Req() req: Request,
  ) {
    const body = req.body;
    if (!Buffer.isBuffer(body)) {
      throw new NotFoundException({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'Send the file as a raw body with its own Content-Type',
      });
    }
    const asset = await this.media.upload({
      lessonId: query.lessonId,
      kind: query.kind,
      locale: query.locale,
      contentType: req.headers['content-type'] ?? 'application/octet-stream',
      body,
      durationSeconds: query.durationSeconds ?? null,
    });
    return { asset: { ...asset, storageKey: undefined } };
  }

  /**
   * Point a lesson at media that lives somewhere else (docs/74).
   *
   * JSON rather than raw bytes, because there are no bytes — this records a
   * reference. The response says plainly that the release rules become advice
   * for this asset, so the screen that called it has the sentence to show and
   * does not have to invent one.
   */
  @Post('learning/assets/external')
  @RequirePermissions(PERMISSIONS.LEARNING_MANAGE)
  async link(@Body(new ZodPipe(externalSchema)) body: z.infer<typeof externalSchema>) {
    const asset = await this.media.registerExternal({
      lessonId: body.lessonId,
      kind: body.kind,
      locale: body.locale,
      provider: body.provider,
      externalId: body.externalId,
      durationSeconds: body.durationSeconds ?? null,
    });
    return {
      asset,
      accessControl: 'advisory',
      warning:
        'Anyone who has the link can watch this, whether or not it has been released to them. ' +
        'Releasing controls what this product shows, not what YouTube serves.',
    };
  }

  /**
   * Play a lesson's media.
   *
   * Every byte passes through here, which is what keeps the release check in
   * front of the content (docs/71): a URL that works without this API is a
   * library with its access control removed.
   *
   * `Range` is answered properly because iOS Safari will not play a `<video>`
   * from a server that does not — this is the difference between the feature
   * working on a phone and not existing there (docs/73 §7).
   */
  @Get('learning/lessons/:id/media')
  @RequirePermissions(PERMISSIONS.LEARNING_VIEW)
  @RequireEntitlements(ENTITLEMENTS.COURSE_ACCESS)
  async play(
    @Param('id', ParseUUIDPipe) lessonId: string,
    @Query(new ZodPipe(playQuerySchema)) query: z.infer<typeof playQuerySchema>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const asset = await this.media.assetFor(this.memberId(), lessonId, query.kind, query.locale);
    const { request, body } = await this.media.open(asset, req.headers.range);

    if (request.kind === 'unsatisfiable') {
      // 416 must name the real length, or the player has no way to correct its
      // next request and simply asks the same impossible thing again.
      res.setHeader('Content-Range', `bytes */${asset.byteSize}`);
      res.status(416).end();
      return;
    }
    if (!body) {
      res.status(404).json({ code: ERROR_CODES.NOT_FOUND, message: 'Media not found' });
      return;
    }

    res.setHeader('Content-Type', body.contentType);
    res.setHeader('Content-Length', String(body.contentLength));
    // Without this header a browser will not even try a ranged request, so
    // seeking never happens and iOS never starts.
    res.setHeader('Accept-Ranges', 'bytes');
    // Photographs are served `no-store` (docs/65) because a consent photograph
    // in a cache is a copy nobody agreed to. A lesson video is not that, and
    // `no-store` would re-fetch from byte zero on every seek — on a phone, the
    // difference between usable and not. Private, so no shared proxy keeps it.
    res.setHeader('Cache-Control', 'private, max-age=300');
    // The locale that was actually served, which may not be the one asked for
    // when only a `*` asset exists. Silently substituting a language and not
    // saying so is how somebody concludes the player is broken.
    res.setHeader('Content-Language', asset.locale === ANY_LOCALE ? 'und' : asset.locale);

    if (request.kind === 'range') {
      res.status(206);
      res.setHeader(
        'Content-Range',
        `bytes ${request.range.start}-${request.range.end}/${body.totalLength}`,
      );
    } else {
      res.status(200);
    }

    // A store that dies mid-stream cannot be turned into a status code — the
    // headers have gone. Destroying the socket tells the player something went
    // wrong instead of leaving it waiting on a response that has stopped.
    body.stream.on('error', () => res.destroy());
    body.stream.pipe(res);
  }

  /** How far through a lesson the caller is. Intrinsically SELF — docs/10 row 91. */
  @Post('learning/lessons/:id/progress')
  @RequirePermissions(PERMISSIONS.LEARNING_VIEW)
  async progress(@Param('id', ParseUUIDPipe) lessonId: string, @Req() req: Request) {
    const memberId = this.memberId();
    if (!memberId) {
      throw new NotFoundException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    const body = progressSchema.parse(req.body);
    return { view: await this.media.recordProgress(memberId, lessonId, body) };
  }
}
