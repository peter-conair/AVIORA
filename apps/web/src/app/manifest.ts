import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'AVIORA',
    short_name: 'AVIORA',
    description: 'Membership & Healthy Living Growth OS',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#0f766e',
  };
}
