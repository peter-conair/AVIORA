import { Module } from '@nestjs/common';
import { CommerceModule } from '../commerce/commerce.module';
import { CompensationModule } from '../compensation/compensation.module';
import { GrowthModule } from '../growth/growth.module';
import { ObservabilityModule } from '../observability/observability.module';
import { SchedulerController } from './scheduler.controller';
import { SchedulerService } from './scheduler.service';

/**
 * The scheduler (docs/35). It imports the modules whose services it calls
 * rather than reaching for their tables: every job here is the same call an
 * administrator's button already makes, and a module boundary is the cheapest
 * way to keep it that way.
 */
@Module({
  imports: [CommerceModule, GrowthModule, CompensationModule, ObservabilityModule],
  controllers: [SchedulerController],
  providers: [SchedulerService],
})
export class SchedulerModule {}
