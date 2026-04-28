import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { RemindersCard } from '@/components/features/settings/reminders-card';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { listMyReminders } from '@/lib/db/queries/reminders';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function RemindersSettingsPage() {
  const [tenant, user] = await Promise.all([getCurrentTenant(), getCurrentUser()]);
  if (!user) redirect('/login');
  if (!tenant) redirect('/signup?error=no_tenant');

  const reminders = await listMyReminders(tenant.member.id);

  // Look up the operator's notification_phone (richer field) — fall back to
  // their verified onboarding phone.
  const supabase = await createClient();
  const { data: m } = await supabase
    .from('tenant_members')
    .select('notification_phone, phone')
    .eq('id', tenant.member.id)
    .maybeSingle();
  const notificationPhone =
    (m?.notification_phone as string | null) ?? (m?.phone as string | null) ?? null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to settings
        </Link>
      </div>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reminders</h1>
        <p className="text-sm text-muted-foreground">
          Recurring SMS nudges so the things that need to happen each day actually do.
        </p>
      </div>

      <RemindersCard reminders={reminders} notificationPhone={notificationPhone} />
    </div>
  );
}
