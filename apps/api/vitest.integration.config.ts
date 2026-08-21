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
    /**
     * Coverage is measured HERE, not on the unit run, because this is where the
     * tests are: 609 of them, through real HTTP against a real database. Unit
     * coverage of this codebase is 2.7% and that is the design — docs/23's
     * "≥80%" is about how much of the code is exercised, and asking the unit
     * runner is asking the wrong instrument.
     *
     * Thresholds apply only when coverage is requested (`pnpm test:coverage`),
     * so an ordinary CI run is not slowed by instrumentation. They sit a little
     * below the current numbers — a floor with headroom, not a ratchet that
     * turns an unrelated refactor red.
     */
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/main.ts'],
      thresholds: { statements: 85, functions: 90, branches: 75, lines: 85 },
    },
  },
});
