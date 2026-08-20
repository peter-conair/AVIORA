import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TenantConfigModule } from '../tenant-config/tenant-config.module';
import { ApiKeyController } from './api-key.controller';
import { ApiKeyGuard } from './api-key.guard';
import { ApiKeyService } from './api-key.service';
import { ManifestController } from './manifest.controller';
import { ManifestService } from './manifest.service';
import { PublicApiController } from './public.controller';
import { PublicApiService } from './public.service';
import { PublicRateLimitMiddleware } from './rate-limit';
import { WebhookController } from './webhook.controller';
import { WebhookDispatcher } from './webhook.dispatcher';
import { WebhookService } from './webhook.service';

/**
 * Public API, webhooks and the branded manifest (docs/30).
 *
 * Three surfaces, one module, because they are one story: a tenant's system
 * talking to AVIORA (API keys), AVIORA talking back to it (webhooks), and the
 * app it installs on a phone carrying the tenant's name (the manifest).
 *
 * WebhookDispatcher is exported rather than subscribed to here. Registering
 * the bus handler lives in AppModule beside the bus itself, the way every
 * other `*Handlers` class in this codebase does — see webhook.handlers.ts.
 * The dispatcher's own retry timer starts here.
 */
@Module({
  imports: [TenantConfigModule],
  controllers: [WebhookController, ApiKeyController, PublicApiController, ManifestController],
  providers: [
    WebhookService,
    WebhookDispatcher,
    ApiKeyService,
    ApiKeyGuard,
    PublicApiService,
    ManifestService,
    PublicRateLimitMiddleware,
  ],
  exports: [WebhookDispatcher],
})
export class IntegrationModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Bound to the controller rather than a path pattern: the rate limit
    // follows the public routes wherever they are mounted, and the three
    // headers land on every response those routes produce — including the 401
    // a bad key gets, which a guard-based limiter would never reach.
    consumer.apply(PublicRateLimitMiddleware).forRoutes(PublicApiController);
  }
}
