import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Load measurements (docs/41). Kept OUT of the default and integration configs
 * on purpose: these fill an outbox with thousands of events and report numbers
 * rather than assert behaviour, so they belong in a deliberate run
 * (`pnpm db:outbox-load`) and not on every push.
 */
export default defineConfig({
  // esbuild does not emit decorator metadata — Nest DI needs SWC here, the same
  // reason the integration config uses it.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/load/**/*.spec.ts'],
    pool: 'forks',
    setupFiles: ['test/setup-env.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
