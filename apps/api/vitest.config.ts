import { defineConfig } from 'vitest/config';

// Unit tests only — integration specs (real Postgres) run via vitest.integration.config.ts
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    passWithNoTests: true,
  },
});
