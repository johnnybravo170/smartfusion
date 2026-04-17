import type { LucideIcon } from 'lucide-react';
import {
  ClipboardList,
  FileText,
  FolderKanban,
  Gift,
  Inbox,
  LayoutDashboard,
  Receipt,
  Settings,
  Users,
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
  { href: '/referrals', label: 'Refer & Earn', icon: Gift },
  { href: '/settings', label: 'Settings', icon: Settings },
];

const PROJECTS_ITEM: NavItem = {
  href: '/projects',
  label: 'Projects',
  icon: FolderKanban,
};

/**
 * Returns the navigation items for the given vertical.
 * Renovation tenants get a "Projects" item between Customers and Quotes.
 */
export function getNavItems(vertical: string): NavItem[] {
  if (vertical === 'renovation' || vertical === 'tile') {
    // Insert Projects after Customers (index 1 = Customers, so insert at index 2)
    const items = [...CORE_ITEMS];
    items.splice(2, 0, PROJECTS_ITEM);
    return items;
  }
  return CORE_ITEMS;
}

/**
 * @deprecated Use `getNavItems(vertical)` instead. Kept for type compatibility
 * during the transition.
 */
export const NAV_ITEMS = CORE_ITEMS;
