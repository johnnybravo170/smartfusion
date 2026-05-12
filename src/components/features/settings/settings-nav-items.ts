/**
 * Single source of truth for the settings sidebar + mobile nav.
 *
 * Edit this file to add / remove / reorder settings items. Both the
 * desktop sidebar and the mobile <select> read from here, so they stay
 * in lockstep automatically.
 *
 * `href` is the canonical route. The active-state highlight uses a
 * startsWith match so nested orphan routes (e.g. /settings/qbo-history)
 * light up their parent (QuickBooks) without explicit configuration.
 */

import type { LucideIcon } from 'lucide-react';
import {
  Bell,
  Bot,
  Building2,
  Calendar,
  CreditCard,
  Database,
  FileText,
  HardHat,
  Layers,
  Mic,
  Receipt,
  Ruler,
  ShieldCheck,
  Tag,
  TrendingUp,
  Upload,
  Users,
  Wallet,
} from 'lucide-react';

export type SettingsNavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
};

export type SettingsNavGroup = {
  /** Uppercase label shown above the items in the sidebar. */
  label: string;
  items: SettingsNavItem[];
};

export const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    label: 'Account',
    items: [
      { title: 'Business profile', href: '/settings/profile', icon: Building2 },
      { title: 'Security', href: '/settings/security', icon: ShieldCheck },
      { title: 'Team', href: '/settings/team', icon: Users },
    ],
  },
  {
    label: 'Billing & plan',
    items: [{ title: 'Billing', href: '/settings/billing', icon: CreditCard }],
  },
  {
    label: 'Estimating & quotes',
    items: [
      { title: 'Project defaults', href: '/settings/project-defaults', icon: TrendingUp },
      { title: 'Estimating detail level', href: '/settings/estimating', icon: Ruler },
      { title: 'Pricebook', href: '/settings/pricebook', icon: Tag },
      { title: 'Cost catalog', href: '/settings/cost-catalog', icon: HardHat },
      { title: 'Bucket templates', href: '/settings/budget-category-templates', icon: Layers },
      { title: 'Estimate snippets', href: '/settings/estimate-snippets', icon: FileText },
      { title: 'Quotes', href: '/settings/quotes', icon: FileText },
    ],
  },
  {
    label: 'Money & integrations',
    items: [
      { title: 'Stripe', href: '/settings/stripe', icon: Wallet },
      { title: 'QuickBooks', href: '/settings/quickbooks', icon: Receipt },
      { title: 'Payment sources', href: '/settings/payment-sources', icon: CreditCard },
      { title: 'Invoicing', href: '/settings/invoicing', icon: FileText },
      { title: 'Expense categories', href: '/settings/categories', icon: Tag },
    ],
  },
  {
    label: 'Operations',
    items: [
      { title: 'Automations', href: '/settings/automations', icon: Bot },
      { title: 'Reminders', href: '/settings/reminders', icon: Bell },
      { title: 'Checklist settings', href: '/settings/checklist', icon: Layers },
    ],
  },
  {
    label: 'Data & tools',
    items: [
      { title: 'Calendar feed', href: '/settings/calendar', icon: Calendar },
      { title: 'Data export', href: '/settings/data-export', icon: Database },
      { title: 'Import data', href: '/import', icon: Upload },
      { title: 'Voice', href: '/settings/voice', icon: Mic },
    ],
  },
];

/** Flat list of every nav item — handy for tests, search, lookups. */
export const ALL_SETTINGS_ITEMS: SettingsNavItem[] = SETTINGS_NAV.flatMap((g) => g.items);

/** True when `pathname` belongs to the given nav item — exact match or a
 *  nested subpath. Nested orphan routes (e.g. /settings/qbo-history) light
 *  up their parent (QuickBooks at /settings/quickbooks) so the sidebar
 *  never shows "nothing selected." */
export function isSettingsItemActive(pathname: string, item: SettingsNavItem): boolean {
  if (pathname === item.href) return true;
  return pathname.startsWith(`${item.href}/`);
}
