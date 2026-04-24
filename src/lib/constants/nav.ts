import type { LucideIcon } from 'lucide-react';
import {
  CalendarDays,
  ClipboardList,
  FileText,
  FolderKanban,
  Gift,
  Inbox,
  LayoutDashboard,
  Receipt,
  Settings,
  UserCog,
  Users,
  Wallet,
} from 'lucide-react';

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

const CORE_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/customers', label: 'Customers', icon: Users },
  { href: '/quotes', label: 'Quotes', icon: FileText },
  { href: '/jobs', label: 'Jobs', icon: ClipboardList },
  { href: '/invoices', label: 'Invoices', icon: Receipt },
  { href: '/inbox', label: 'Inbox', icon: Inbox },
  { href: '/settings/team', label: 'Team', icon: UserCog },
  { href: '/referrals', label: 'Refer & Earn', icon: Gift },
  { href: '/settings', label: 'Settings', icon: Settings },
];

const PROJECTS_ITEM: NavItem = {
  href: '/projects',
  label: 'Projects',
  icon: FolderKanban,
};

const CALENDAR_ITEM: NavItem = {
  href: '/calendar',
  label: 'Calendar',
  icon: CalendarDays,
};

const EXPENSES_ITEM: NavItem = {
  href: '/expenses',
  label: 'Expenses',
  icon: Wallet,
};

/**
 * Returns the navigation items for the given vertical.
 *
 * Renovation + tile tenants:
 *   - Get "Projects" + "Calendar" between Customers and Jobs
 *   - Do NOT get "Quotes" — the polygon-measurement quoting tool is for
 *     pressure-washing-style verticals. Renovation estimates live on
 *     projects (projects.estimate_status + lifecycle_stage).
 */
export function getNavItems(vertical: string): NavItem[] {
  if (vertical === 'renovation' || vertical === 'tile') {
    const items = CORE_ITEMS.filter((item) => item.href !== '/quotes');
    // Insert Projects + Calendar after Customers (index 1 = Customers).
    items.splice(2, 0, PROJECTS_ITEM, CALENDAR_ITEM);
    // Expenses sits after Invoices (money-related surfaces live together).
    const invoicesIdx = items.findIndex((i) => i.href === '/invoices');
    if (invoicesIdx >= 0) items.splice(invoicesIdx + 1, 0, EXPENSES_ITEM);
    else items.push(EXPENSES_ITEM);
    return items;
  }
  return CORE_ITEMS;
}

/**
 * @deprecated Use `getNavItems(vertical)` instead. Kept for type compatibility
 * during the transition.
 */
export const NAV_ITEMS = CORE_ITEMS;
