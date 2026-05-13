'use client';

/**
 * Mobile (<sm) replacement for the settings sidebar. A native <select>
 * with <optgroup> labels — zero JS to manage, accessible by default,
 * works on every browser.
 *
 * Navigates with router.push when the operator picks an item.
 */

import { usePathname, useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { getSettingsNav, isSettingsItemActive } from './settings-nav-items';

export function SettingsMobileNav({ vertical }: { vertical: string | null }) {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  // See sidebar for the rationale — derive filtered groups on the client
  // from the primitive vertical so we don't try to serialize icon refs.
  const groups = useMemo(() => getSettingsNav({ vertical }), [vertical]);

  // Determine the currently-active value so the select preselects it.
  // Falls back to the first item if no match (e.g. /settings index hit
  // before its redirect fires).
  const activeHref =
    groups.flatMap((g) => g.items).find((item) => isSettingsItemActive(pathname, item))?.href ??
    groups[0]?.items[0]?.href ??
    '';

  return (
    <div className="mb-4 sm:hidden">
      <label htmlFor="settings-mobile-nav" className="sr-only">
        Settings section
      </label>
      <select
        id="settings-mobile-nav"
        value={activeHref}
        onChange={(e) => router.push(e.target.value)}
        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
      >
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.items.map((item) => (
              <option key={item.href} value={item.href}>
                {item.title}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
