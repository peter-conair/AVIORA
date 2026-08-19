import { Controller, Get, Headers, Param, Query } from '@nestjs/common';
import { PERMISSIONS } from '@aviora/shared';
import { RequirePermissions } from '../../common/auth/decorators';
import { KnowledgeService } from './knowledge.service';

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
}
