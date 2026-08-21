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
    // Registered TWICE, deliberately, because the two hooks do different jobs
    // and the file exports one thing for each:
    //   · setupFiles runs per worker and loads .env into that worker.
    //   · globalSetup runs once and is the ONLY hook that calls the exported
    //     `setup()`. It had been registered as a setupFile alone, so the
    //     "is an API server draining your events?" guard never ran — a safety
    //     net that reads like protection and has never fired is worse than
    //     none, because the flakes it was meant to explain get blamed on the
    //     product instead.
    globalSetup: ['test/setup-env.ts'],
    setupFiles: ['test/setup-env.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Isolation tests share DB fixtures — run serially to stay deterministic.
    fileParallelism: false,
  },
});
