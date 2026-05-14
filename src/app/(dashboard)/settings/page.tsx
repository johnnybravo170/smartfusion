import { redirect } from 'next/navigation';

/**
 * Settings root — redirects into Business profile, which is the first
 * item in the sidebar nav. The previous flat-list landing page is gone;
 * every setting now lives at its own URL with the sidebar mounted via
 * `settings/layout.tsx`.
 */
export default function SettingsPage() {
  redirect('/settings/profile');
}
