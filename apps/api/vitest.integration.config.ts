import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.spec.ts'],
    setupFiles: ['test/setup-env.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Isolation tests share DB fixtures — run serially to stay deterministic.
    fileParallelism: false,
  },
});
