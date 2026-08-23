import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  /**
   * A build and the dev server must not share an output directory.
   *
   * `turbo typecheck` depends on `build`, so every lint/typecheck run wrote
   * into the `.next` the running dev server was serving from. The result was
   * always the same: every page 500s with a JSON parse error naming no file,
   * and the only cure is killing the server and deleting the directory.
   *
   * It cost several minutes on most sprints and would hit anybody running the
   * dev server while CI-style checks ran beside it. A build now writes to
   * `.next-build` and leaves the dev server's directory alone.
   */
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
