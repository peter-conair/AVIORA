import { Controller, Get, Param, Query } from '@nestjs/common';
import { PERMISSIONS } from '@aviora/shared';
import { RequirePermissions } from '../../common/auth/decorators';
import { KnowledgeService } from './knowledge.service';

@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get('health-goals')
  @RequirePermissions(PERMISSIONS.LEARNING_VIEW)
  async healthGoals() {
    return { healthGoals: await this.knowledge.healthGoals() };
  }

  @Get('journey/:goalCode')
  @RequirePermissions(PERMISSIONS.LEARNING_VIEW)
  async journey(@Param('goalCode') goalCode: string) {
    return await this.knowledge.journey(goalCode);
  }

  @Get('articles/:slug')
  @RequirePermissions(PERMISSIONS.LEARNING_VIEW)
  async article(@Param('slug') slug: string) {
    return { article: await this.knowledge.article(slug) };
  }

  @Get('ingredients/:code')
  @RequirePermissions(PERMISSIONS.LEARNING_VIEW)
  async ingredient(@Param('code') code: string) {
    return { ingredient: await this.knowledge.ingredient(code) };
  }

  @Get('search')
  @RequirePermissions(PERMISSIONS.LEARNING_VIEW)
  async search(@Query('q') q = '') {
    return await this.knowledge.search(q);
  }
}
