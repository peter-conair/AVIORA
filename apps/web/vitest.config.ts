import { defineConfig } from 'vitest/config';

// Unit/component tests only. The e2e/ directory belongs to Playwright, which
// has its own runner and would fail here on Playwright's own `test` import.
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
    passWithNoTests: true,
  },
});
