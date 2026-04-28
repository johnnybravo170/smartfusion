'use client';

/**
 * Resolves a Lucide icon name (string from vertical_profile_packs.config) to
 * its React component. Only the icons currently in use across the seeded
 * packs are mapped — adding a new icon to a pack means adding a line here.
 *
 * Falls back to a generic placeholder so a typo in a pack doesn't crash
 * the sidebar.
 */

import {
  CalendarDays,
  Circle,
  ClipboardList,
  FileText,
  FolderKanban,
  Gift,
  Inbox,
  LayoutDashboard,
  type LucideIcon,
  Receipt,
  Settings,
  UserCog,
  Users,
  Wallet,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
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
};

export function resolveIcon(name: string): LucideIcon {
  return ICONS[name] ?? Circle;
}
