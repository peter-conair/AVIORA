import type { IconName } from '@/components/NavIcon';
import type { HideableFeature } from '@/lib/types';

/**
 * The navigation map, in one place.
 *
 * Grouped by what a person is TRYING TO DO, not by the module that happens to
 * serve it. The module map ("health", "commerce", "growth") is how the software
 * was built; nobody opens an app thinking in modules. So personal things come
 * first, the collective things after, and administration last — the order
 * people need them in.
 *
 * `feature` is the key a tenant may hide via branding. Hiding removes the
 * ENTRY only: the route still answers, because access is the guards' job
 * (docs/29 §1). Nothing in this file is ever consulted for a permission.
 */
export interface NavItem {
  href: string;
  /** `shell.nav.<key>` message key. */
  key: string;
  icon: IconName;
  /**
   * Optional branding feature key; absent means it can never be hidden. Typed
   * against the branding screen's own list, so the two cannot drift apart
   * without the compiler saying so.
   */
  feature?: HideableFeature;
  platformOnly?: boolean;
}

export interface NavGroup {
  /** `shell.groups.<key>` message key. */
  key: string;
  icon: IconName;
  items: NavItem[];
}

export const HOME: NavItem = { href: '/dashboard', key: 'dashboard', icon: 'home' };

export const NAV_GROUPS: NavGroup[] = [
  {
    // What I am doing with myself. The daily loop of the product.
    key: 'journey',
    icon: 'health',
    items: [
      { href: '/health', key: 'health', icon: 'health', feature: 'health' },
      { href: '/goals', key: 'goals', icon: 'goals', feature: 'goals' },
      { href: '/challenges', key: 'challenges', icon: 'challenges', feature: 'challenges' },
      { href: '/learning', key: 'learning', icon: 'learning', feature: 'learning' },
    ],
  },
  {
    // How far I have got. Rank, recognition and money sit together because a
    // member checks them in one sitting, and splitting them sends people
    // hunting through two groups for one answer.
    key: 'progress',
    icon: 'growth',
    items: [
      { href: '/growth', key: 'growth', icon: 'growth', feature: 'ranks' },
      { href: '/rewards', key: 'rewards', icon: 'points', feature: 'gamification' },
      { href: '/my-rewards', key: 'myRewards', icon: 'gift', feature: 'rewards' },
      { href: '/earnings', key: 'earnings', icon: 'wallet', feature: 'compensation' },
    ],
  },
  {
    key: 'knowledge',
    icon: 'knowledge',
    items: [
      { href: '/knowledge', key: 'knowledge', icon: 'knowledge', feature: 'knowledge' },
      { href: '/assistant', key: 'assistant', icon: 'assistant', feature: 'ai' },
    ],
  },
  {
    // Buying, and what I have bought. One flow, so one group.
    key: 'shop',
    icon: 'shop',
    items: [
      { href: '/shop', key: 'shop', icon: 'shop', feature: 'commerce' },
      { href: '/orders', key: 'orders', icon: 'orders', feature: 'commerce' },
    ],
  },
  {
    // The people around me — which is not the same as the people I sell to.
    key: 'people',
    icon: 'community',
    items: [
      { href: '/community', key: 'community', icon: 'community', feature: 'community' },
      { href: '/teams', key: 'teams', icon: 'teams', feature: 'teams' },
      { href: '/leader', key: 'leader', icon: 'leader', feature: 'teams' },
    ],
  },
  {
    // Work I do on behalf of the business. Deliberately apart from the shop:
    // buying and selling are different jobs in different frames of mind.
    key: 'customers',
    icon: 'customers',
    items: [
      // Ahead of the CRM on purpose: finding names is what a new member does
      // first, and the pipeline is empty until they have (docs/56).
      { href: '/prospecting', key: 'prospecting', icon: 'customers', feature: 'crm' },
      { href: '/crm', key: 'crm', icon: 'customers', feature: 'crm' },
      { href: '/follow-ups', key: 'followUps', icon: 'followUps', feature: 'crm' },
    ],
  },
  {
    key: 'administration',
    icon: 'admin',
    items: [
      { href: '/admin', key: 'admin', icon: 'admin' },
      { href: '/platform', key: 'platform', icon: 'platform', platformOnly: true },
    ],
  },
];

/**
 * The bottom bar on a phone: four destinations plus the menu. A thumb reaches
 * five targets comfortably and no more, so these are the four people open
 * daily — what I am doing, who I am doing it with, and how far I have got.
 * Everything else is exactly one tap away, never further.
 */
export const PRIMARY_TABS: NavItem[] = [
  HOME,
  { href: '/health', key: 'health', icon: 'health', feature: 'health' },
  { href: '/community', key: 'community', icon: 'community', feature: 'community' },
  { href: '/growth', key: 'growth', icon: 'growth', feature: 'ranks' },
];

export function visibleGroups(hidden: string[], isPlatformAdmin: boolean): NavGroup[] {
  const hiddenSet = new Set(hidden);
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) =>
        (!item.feature || !hiddenSet.has(item.feature)) && (!item.platformOnly || isPlatformAdmin),
    ),
  })).filter((group) => group.items.length > 0);
}

export function visibleTabs(hidden: string[]): NavItem[] {
  const hiddenSet = new Set(hidden);
  return PRIMARY_TABS.filter((item) => !item.feature || !hiddenSet.has(item.feature));
}
