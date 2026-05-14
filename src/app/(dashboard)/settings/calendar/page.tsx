import { CalendarFeedCard } from '@/components/features/settings/calendar-feed-card';
import { SettingsPageHeader } from '@/components/features/settings/settings-page-header';
import { getCurrentTenant } from '@/lib/auth/helpers';

export const metadata = { title: 'Calendar — Settings' };

export default async function CalendarSettingsPage() {
  const tenant = await getCurrentTenant();
  if (!tenant?.slug) return null;

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.heyhenry.io';
  const feedUrl = `${baseUrl}/api/calendar/${tenant.slug}.ics`;

  return (
    <>
      <SettingsPageHeader
        title="Calendar feed"
        description="Subscribe to your scheduled jobs in Google Calendar, Apple Calendar, or any iCal-aware app."
      />
      <CalendarFeedCard feedUrl={feedUrl} />
    </>
  );
}
