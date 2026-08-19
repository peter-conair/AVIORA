/**
 * Module boundary rules (docs/21 §5). These exist so the modular monolith stays
 * extractable: a module that reaches into another module's internals cannot be
 * lifted out later without dragging that module with it.
 *
 * Enforced, not aspirational — CI fails on a violation.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import reactHooks from 'eslint-plugin-react-hooks';

/** Layer rules inside apps/api (see docs/21 §2 "Layer rules"). */
const apiBoundaries = {
  files: ['apps/api/src/**/*.ts'],
  plugins: { import: importPlugin },
  rules: {
    'import/no-restricted-paths': [
      'error',
      {
        zones: [
          // domain layer stays pure: no framework, no database, no siblings
          {
            target: './apps/api/src/modules/*/domain',
            from: './apps/api/src/modules',
            except: ['./*/domain'],
            message:
              'domain/ may only import its own module. Keep it free of Nest, Prisma, and siblings.',
          },
          // controllers must not reach the database directly — services own it
          {
            target: './apps/api/src/modules/*/api',
            from: './packages/db',
            message: 'api/ must go through its module services, never Prisma directly.',
          },
          // only the platform module may use the owner (RLS-exempt) client
          {
            target: './apps/api/src/modules',
            from: './packages/db/src/platform-client.ts',
            message: 'The owner client is platform-scope only.',
          },
          // AI provider SDKs stay behind the gateway's infrastructure layer
          {
            target: './apps/api/src/modules',
            from: './apps/api/src/modules/ai/anthropic.provider.ts',
            except: ['./ai'],
            message: 'Provider adapters are internal to modules/ai — depend on the gateway.',
          },
        ],
      },
    ],
    // cross-module imports must go through a module's public surface
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['**/modules/*/infrastructure/*'],
            message:
              "Another module's infrastructure is private. Use its exported service or a domain event.",
          },
        ],
      },
    ],
  },
};

/** The web app must not import server-only packages. */
const webBoundaries = {
  files: ['apps/web/src/**/*.{ts,tsx}'],
  plugins: { 'react-hooks': reactHooks },
  rules: {
    ...reactHooks.configs.recommended.rules,
    // rules-of-hooks and exhaustive-deps stay on — they catch real bugs.
    // set-state-in-effect is a performance advisory from the React Compiler
    // rule set; every data-loading page here sets state in an effect, so
    // turning it on means a refactor of the whole app. Tracked, not silenced
    // by inline comments.
    'react-hooks/set-state-in-effect': 'off',
    'no-restricted-imports': [
      'error',
      {
        paths: [
          { name: '@aviora/db', message: 'The browser must never import the database package.' },
          { name: '@prisma/client', message: 'The browser must never import Prisma.' },
        ],
      },
    ],
  },
};

export default [
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/*.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // the codebase leans on inference; explicit-any is the signal that matters
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  apiBoundaries,
  webBoundaries,
];
