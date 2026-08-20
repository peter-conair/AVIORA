/**
 * Stroke icons for the navigation.
 *
 * Inline SVG rather than an icon package: a fixed set of one-line paths does
 * not justify a dependency, and these inherit `currentColor` so an active tab
 * needs no second asset. `aria-hidden` throughout — every icon sits beside a
 * real label, and announcing it twice only slows a screen reader down.
 */
export type IconName =
  | 'home'
  | 'health'
  | 'goals'
  | 'challenges'
  | 'learning'
  | 'growth'
  | 'points'
  | 'gift'
  | 'wallet'
  | 'knowledge'
  | 'assistant'
  | 'shop'
  | 'orders'
  | 'community'
  | 'teams'
  | 'leader'
  | 'customers'
  | 'followUps'
  | 'admin'
  | 'platform'
  | 'menu'
  | 'close';

const PATHS: Record<IconName, string> = {
  home: 'M3 10.5 12 3l9 7.5M5.5 9.5V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5',
  health: 'M12 20s-7-4.5-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.5-7 9-7 9Z',
  goals:
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-4.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0-3a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  challenges: 'M6 21V4m0 0h11l-2 3.5L17 11H6',
  learning:
    'M4 6.5A2.5 2.5 0 0 1 6.5 4H20v13H6.5A2.5 2.5 0 0 0 4 19.5v-13Zm0 13A2.5 2.5 0 0 1 6.5 17H20v3H6.5A2.5 2.5 0 0 1 4 19.5Z',
  growth: 'M4 18 9.5 12l3.5 3.5L20 7M20 7h-4.5M20 7v4.5',
  points: 'm12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4L4.2 9.7l5.4-.8L12 4Z',
  gift: 'M4 12h16v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8Zm-.5-4h17v4h-17V8ZM12 8v13M12 8S10.5 4 8.5 4a2 2 0 0 0 0 4M12 8s1.5-4 3.5-4a2 2 0 0 1 0 4',
  wallet:
    'M4 8.5A1.5 1.5 0 0 1 5.5 7H19a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5.5A1.5 1.5 0 0 1 4 17.5v-9Zm0 0A1.5 1.5 0 0 0 5.5 10H20M16.5 14h.01',
  knowledge: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm3.5-12.5-2 5-5 2 2-5 5-2Z',
  assistant:
    'm12 3 1.8 4.9L18.5 9l-4.7 1.8L12 15.5l-1.8-4.7L5.5 9l4.7-1.1L12 3ZM18 16l.9 2.4 2.1.6-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.6L18 16Z',
  shop: 'M4 8h16l-1.2 10.2a2 2 0 0 1-2 1.8H7.2a2 2 0 0 1-2-1.8L4 8Zm4 0V6a4 4 0 0 1 8 0v2',
  orders: 'M6 3h9l3 3v15H6V3Zm3 6h6M9 13h6M9 17h4',
  community: 'M16 19v-1a4 4 0 0 0-8 0v1M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M20 19v-1a3 3 0 0 0-2.5-3',
  teams:
    'M12 3v4m0 0H6v3m6-3h6v3M6 10v0m0 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm12 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm-6-3a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  leader: 'M4 19h16M7 19v-6m5 6V6m5 13v-9',
  customers: 'M15 19v-1a4 4 0 0 0-8 0v1M11 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 8v6M21 11h-6',
  followUps: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5l3 2',
  admin:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7.5 7.5 0 0 0-2-1.2L14.6 3h-4l-.4 2.5a7.5 7.5 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.5l-2 1.5 2 3.4 2.3-.9c.6.5 1.3.9 2 1.2l.4 2.5h4l.4-2.5c.7-.3 1.4-.7 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z',
  platform:
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-9-9h18M12 3c2.5 2.5 3.8 5.5 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3Z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6 6 18',
};

export function NavIcon({ name, className = 'h-5 w-5' }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
