import { Module } from '@nestjs/common';
import { ObservabilityController, TenantUsageController } from './observability.controller';
import { ObservabilityService } from './observability.service';
import { AlertsService } from './alerts.service';
import { EmailModule } from '../../common/email/email.module';

@Module({
  imports: [EmailModule],
  controllers: [ObservabilityController, TenantUsageController],
  providers: [ObservabilityService, AlertsService],
  // The scheduler's `alert.sweep` job calls AlertsService (docs/42 §3): the
  // sweep is a scheduled job so it inherits one-run-per-occurrence and leaves a
  // row saying it happened. Alerting on its own timer would be a second
  // scheduler nobody could see.
  exports: [ObservabilityService, AlertsService],
})
export class ObservabilityModule {}
