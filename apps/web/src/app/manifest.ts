import type { MetadataRoute } from 'next';
import { BRAND } from '@aviora/shared';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BRAND.name,
    short_name: BRAND.shortName,
    description: 'Membership & Healthy Living Growth OS',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#0f766e',
  };
}
