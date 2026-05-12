/**
 * Two-column shell for the entire /settings/* section.
 *
 * Left: persistent sidebar (or mobile <select>) listing every settings
 * destination, grouped by area. Stays mounted across navigations.
 *
 * Right: the active subpage. Wider than the rest of the app (max-w-3xl
 * gets cramped once a sidebar eats 240px on the left).
 */

import { SettingsMobileNav } from '@/components/features/settings/settings-mobile-nav';
import { SettingsSidebar } from '@/components/features/settings/settings-sidebar';

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-6xl gap-6">
      <SettingsSidebar />
      <div className="min-w-0 flex-1">
        <SettingsMobileNav />
        {children}
      </div>
    </div>
  );
}
