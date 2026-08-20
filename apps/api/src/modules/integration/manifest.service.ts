import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/db/prisma.service';
import { BrandingService } from '../tenant-config/branding.service';

export interface WebManifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  orientation: string;
  lang: string;
  dir: string;
  background_color: string;
  theme_color: string;
  icons: Array<{ src: string; sizes: string; type?: string; purpose: string }>;
}

/** Platform defaults, used when a host resolves to no tenant. */
const FALLBACK = {
  name: 'AVIORA',
  theme: '#0f766e',
  background: '#ffffff',
  lang: 'th',
} as const;

/**
 * The white-label manifest (docs/30 §5): the tenant's name, colours and icon,
 * so an installed PWA carries their identity and not ours.
 *
 * Branding comes from BrandingService rather than a second read of the same
 * tables — the colours here are the same colours the login page is painted
 * with, and two code paths deciding what a tenant looks like is one code path
 * too many. Everything it returns has already been validated as DATA (docs/29
 * §7): colours match a colour grammar, the logo is an http(s) URL, and the app
 * name cannot contain markup. Nothing below re-escapes, because nothing below
 * is allowed to receive something that would need escaping.
 */
@Injectable()
export class ManifestService {
  constructor(
    private readonly branding: BrandingService,
    private readonly prisma: PrismaService,
  ) {}

  async forHost(tenantId: string | null): Promise<WebManifest> {
    if (!tenantId) return this.manifest(FALLBACK.name, null, {}, FALLBACK.lang);

    const [branding, tenant] = await Promise.all([
      this.branding.publicBranding(tenantId),
      this.prisma.owner.tenant.findFirst({
        where: { id: tenantId },
        select: { defaultLanguage: true },
      }),
      // publicBranding throws 404 for an unknown or suspended tenant, which is
      // the right answer: a manifest for a tenant that is not serving would
      // install an app that cannot log in.
    ]);

    return this.manifest(
      branding.appName,
      branding.logoUrl,
      branding.colors,
      tenant?.defaultLanguage ?? FALLBACK.lang,
    );
  }

  private manifest(
    name: string,
    logoUrl: string | null,
    colors: Record<string, string>,
    lang: string,
  ): WebManifest {
    return {
      name,
      // A launcher truncates anything much longer; truncating here is honest
      // about what will be shown.
      short_name: name.slice(0, 12),
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      lang,
      dir: 'ltr',
      background_color: colors['surface'] ?? colors['background'] ?? FALLBACK.background,
      theme_color: colors['primary'] ?? FALLBACK.theme,
      // No icon is better than a wrong icon: a manifest that claims a 512px
      // PNG it does not have installs an app with a broken tile.
      icons: logoUrl
        ? [
            { src: logoUrl, sizes: '512x512', type: iconType(logoUrl), purpose: 'any' },
            { src: logoUrl, sizes: '512x512', type: iconType(logoUrl), purpose: 'maskable' },
          ]
        : [],
    };
  }
}

function iconType(url: string): string | undefined {
  const path = url.split('?')[0]?.toLowerCase() ?? '';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  return undefined;
}
