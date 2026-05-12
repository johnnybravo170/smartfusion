'use client';

/**
 * Persistent left nav for `/settings/*`. Stays mounted across navigations
 * via the shared layout — only the right pane re-renders.
 *
 * Nested orphan routes (e.g. /settings/qbo-history) light up their parent
 * via the startsWith match in `isSettingsItemActive`, so the sidebar
 * never shows "nothing selected."
 *
 * Hidden under sm: viewport — `SettingsMobileNav` (a select dropdown)
 * takes over on small screens.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { isSettingsItemActive, SETTINGS_NAV } from './settings-nav-items';

export function SettingsSidebar() {
  const pathname = usePathname() ?? '';

  return (
    <nav aria-label="Settings navigation" className="hidden w-60 shrink-0 border-r pr-4 sm:block">
      <div className="sticky top-4 space-y-6">
        {SETTINGS_NAV.map((group) => (
          <div key={group.label}>
            <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group.label}
            </div>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = isSettingsItemActive(pathname, item);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={cn(
                        'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                        active ? 'bg-foreground text-background' : 'text-foreground hover:bg-muted',
                      )}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="truncate">{item.title}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
