import { Global, Inject, Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { LocalDiskAdapter } from './local-disk.adapter';
import { S3Adapter, s3ConfigFromEnv } from './s3.adapter';
import { STORAGE_PORT, type StoragePort } from './storage.port';

/**
 * Selects the storage adapter (docs/65 §4, docs/71).
 *
 * Two adapters: an S3-compatible one when the environment configures a bucket,
 * a local directory otherwise. The S3 adapter covers MinIO, R2 and AWS alike,
 * so which of those is behind it is a matter of four environment variables and
 * never of code.
 *
 * **Production refuses a non-durable adapter.** Booting a production API with
 * local disk would work perfectly, right up to the first redeploy — at which
 * point photographs customers consented to give exactly once are gone, and
 * nobody finds out until somebody asks for their before picture. Failing at
 * startup is the kinder failure by a wide margin.
 */
/**
 * Extracted so the refusal can be tested (docs/65 §4.1).
 *
 * Left inline it would be a safety control nobody had ever watched fire, which
 * this codebase has now found often enough to stop doing.
 */
export function isProduction(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'production' || env.BACKEND_ENV === 'prod';
}

export function selectStorage(adapter: StoragePort, env: NodeJS.ProcessEnv): StoragePort {
  if (isProduction(env) && !adapter.durable) {
    throw new Error(
      'No durable object storage is configured. Set one up before running in ' +
        'production — the local-disk adapter loses every file on redeploy, and ' +
        'progress photos cannot be re-taken.',
    );
  }
  return adapter;
}

/**
 * Builds the adapter the environment asks for.
 *
 * Extracted for the same reason `selectStorage` is: a branch that decides where
 * customer photographs live should be readable in a test, not only in a running
 * container.
 */
export function buildStorage(local: LocalDiskAdapter, env: NodeJS.ProcessEnv): StoragePort {
  const config = s3ConfigFromEnv(env);
  return selectStorage(config ? new S3Adapter(config) : local, env);
}

@Global()
@Module({
  providers: [
    LocalDiskAdapter,
    {
      provide: STORAGE_PORT,
      inject: [LocalDiskAdapter],
      useFactory: (local: LocalDiskAdapter): StoragePort => {
        const chosen = buildStorage(local, process.env);
        new Logger('StorageModule').log(
          `object storage: ${chosen.name} (durable=${chosen.durable})`,
        );
        return chosen;
      },
    },
  ],
  exports: [STORAGE_PORT],
})
export class StorageModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(StorageModule.name);

  constructor(@Inject(STORAGE_PORT) private readonly storage: StoragePort) {}

  /**
   * A configured bucket must answer before the API accepts traffic.
   *
   * Production refuses to start when it does not. Elsewhere this is a warning,
   * because a developer whose MinIO container is down should get a message
   * rather than an API that will not boot — and outside production the fallback
   * costs nothing but a lost test file.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.storage.verify) return;
    try {
      await this.storage.verify();
      this.logger.log(`object storage reachable: ${this.storage.name}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const message = `object storage ${this.storage.name} is unreachable: ${detail}`;
      if (isProduction(process.env)) throw new Error(message, { cause: err });
      this.logger.warn(message);
    }
  }
}
