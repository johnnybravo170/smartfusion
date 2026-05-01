/**
 * Loads the vertical_profile_packs row for a given vertical. The pack is
 * a JSONB blob whose shape is owned by this file — adding new keys to the
 * JSON requires either a corresponding consumer or a sane default here.
 *
 * Fallback: if no row exists for the requested vertical (or the DB is
 * unreachable), we return a minimal pressure_washing-shaped pack so the
 * shell keeps rendering. Logged so we notice.
 */

import { createAdminClient } from '@/lib/supabase/admin';

export type VerticalNavItem = {
  href: string;
  label: string;
  /** Lucide icon name. Resolved to a component on the client. */
  icon: string;
};

export type VerticalPack = {
  vertical: string;
  displayName: string;
  navItems: VerticalNavItem[];
};

const FALLBACK_NAV: VerticalNavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: 'LayoutDashboard' },
  { href: '/business-health', label: 'Business Health', icon: 'TrendingUp' },
  { href: '/contacts', label: 'Contacts', icon: 'Users' },
  { href: '/inbox', label: 'Inbox', icon: 'Inbox' },
  { href: '/settings', label: 'Settings', icon: 'Settings' },
];

export async function loadVerticalPack(vertical: string | null | undefined): Promise<VerticalPack> {
  const v = vertical || 'pressure_washing';
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('vertical_profile_packs')
    .select('vertical, display_name, config')
    .eq('vertical', v)
    .eq('active', true)
    .maybeSingle();

  if (error || !data) {
    return { vertical: v, displayName: v, navItems: FALLBACK_NAV };
  }

  const cfg = (data.config as Record<string, unknown> | null) ?? {};
  const navItems = Array.isArray(cfg.nav_items)
    ? (cfg.nav_items as VerticalNavItem[]).filter(
        (i) =>
          i &&
          typeof i.href === 'string' &&
          typeof i.label === 'string' &&
          typeof i.icon === 'string',
      )
    : FALLBACK_NAV;

  return {
    vertical: data.vertical as string,
    displayName: (data.display_name as string) ?? v,
    navItems,
  };
}
