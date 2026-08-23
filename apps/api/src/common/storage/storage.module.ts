import { Global, Logger, Module } from '@nestjs/common';
import { LocalDiskAdapter } from './local-disk.adapter';
import { STORAGE_PORT, type StoragePort } from './storage.port';

/**
 * Selects the storage adapter (docs/65 §4).
 *
 * There is exactly one adapter today. The port exists so that adding an R2 or
 * S3 one is a file and a branch here rather than a rewrite of everything that
 * stores a photograph.
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
export function selectStorage(adapter: StoragePort, env: NodeJS.ProcessEnv): StoragePort {
  const isProduction = env.NODE_ENV === 'production' || env.BACKEND_ENV === 'prod';
  if (isProduction && !adapter.durable) {
    throw new Error(
      'No durable object storage is configured. Set one up before running in ' +
        'production — the local-disk adapter loses every file on redeploy, and ' +
        'progress photos cannot be re-taken.',
    );
  }
  return adapter;
}

@Global()
@Module({
  providers: [
    LocalDiskAdapter,
    {
      provide: STORAGE_PORT,
      inject: [LocalDiskAdapter],
      useFactory: (local: LocalDiskAdapter): StoragePort => {
        const chosen = selectStorage(local, process.env);
        new Logger('StorageModule').log(
          `object storage: ${chosen.name} (durable=${chosen.durable})`,
        );
        return chosen;
      },
    },
  ],
  exports: [STORAGE_PORT],
})
export class StorageModule {}
