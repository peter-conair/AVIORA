import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // esbuild does not emit decorator metadata — Nest DI needs SWC here
    swc.vite({ module: { type: 'es6' } }),
  ],
  test: {
    include: ['test/integration/**/*.spec.ts', 'test/e2e/**/*.spec.ts'],
    // native addons (argon2, prisma engines) are not worker_threads-safe
    pool: 'forks',
    setupFiles: ['test/setup-env.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Isolation tests share DB fixtures — run serially to stay deterministic.
    fileParallelism: false,
  },
});
