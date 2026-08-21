import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import { RequirePermissions } from '../../common/auth/decorators';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { KnowledgeService } from './knowledge.service';

const createTeamArticleSchema = z.object({
  teamId: z.string().uuid(),
  slug: z
    .string()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lower-case words joined by hyphens'),
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  summary: z.string().max(500).nullish(),
});

const updateTeamArticleSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).optional(),
  summary: z.string().max(500).nullish(),
  // Unpublishing is a status change, not a delete: knowledge a team acted on
  // should still be findable by the person who has to explain what it said.
  status: z.enum(['published', 'draft']).optional(),
});

const SUPPORTED_LOCALES = ['th', 'en'];

/** Locale comes from the client (?locale= wins, else Accept-Language). */
function resolveLocale(query?: string, header?: string): string {
  if (query && SUPPORTED_LOCALES.includes(query)) return query;
  const fromHeader = header?.split(',')[0]?.trim().slice(0, 2).toLowerCase();
  return fromHeader && SUPPORTED_LOCALES.includes(fromHeader) ? fromHeader : 'en';
}

@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get('health-goals')
  @RequirePermissions(PERMISSIONS.LEARNING_VIEW)
  async healthGoals(
    @Query('locale') locale?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    return {
      healthGoals: await this.knowledge.healthGoals(resolveLocale(locale, acceptLanguage)),
    };
  }

  @Get('journey/:goalCode')
  @RequirePermissions(PERMISSIONS.LEARNING_VIEW)
  async journey(
    @Param('goalCode') goalCode: string,
    @Query('locale') locale?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    return await this.knowledge.journey(goalCode, resolveLocale(locale, acceptLanguage));
  }

  @Get('articles/:slug')
  @RequirePermissions(PERMISSIONS.LEARNING_VIEW)
  async article(
    @Param('slug') slug: string,
    @Query('locale') locale?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    return { article: await this.knowledge.article(slug, resolveLocale(locale, acceptLanguage)) };
  }

  @Get('ingredients/:code')
  @RequirePermissions(PERMISSIONS.LEARNING_VIEW)
  async ingredient(
    @Param('code') code: string,
    @Query('locale') locale?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    return {
      ingredient: await this.knowledge.ingredient(code, resolveLocale(locale, acceptLanguage)),
    };
  }

  @Get('search')
  @RequirePermissions(PERMISSIONS.LEARNING_VIEW)
  async search(
    @Query('q') q = '',
    @Query('locale') locale?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    return await this.knowledge.search(q, resolveLocale(locale, acceptLanguage));
  }

  /* ── team knowledge (docs/37 §5) ─────────────────────────────────────────── */

  /**
   * Publishing is LEADERSHIP — the permission is scoped to the teams the caller
   * leads. Reading team knowledge needs no permission at all; it is membership,
   * and it is enforced inside the search and article queries (docs/37 §2–§3).
   */
  @Post('team-articles')
  @RequirePermissions(PERMISSIONS.KNOWLEDGE_TEAM_MANAGE)
  async createTeamArticle(
    @Body(new ZodPipe(createTeamArticleSchema)) body: z.infer<typeof createTeamArticleSchema>,
  ) {
    return { article: await this.knowledge.createTeamArticle(body) };
  }

  @Patch('team-articles/:id')
  @RequirePermissions(PERMISSIONS.KNOWLEDGE_TEAM_MANAGE)
  async updateTeamArticle(
    @Param('id') id: string,
    @Body(new ZodPipe(updateTeamArticleSchema)) body: z.infer<typeof updateTeamArticleSchema>,
  ) {
    return { article: await this.knowledge.updateTeamArticle(id, body) };
  }

  @Get('team-articles')
  @RequirePermissions(PERMISSIONS.KNOWLEDGE_TEAM_MANAGE)
  async listTeamArticles() {
    return this.knowledge.listTeamArticles();
  }
}
