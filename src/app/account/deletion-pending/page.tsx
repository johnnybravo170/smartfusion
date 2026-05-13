import { redirect } from 'next/navigation';
import { DeletionPendingPanel } from '@/components/features/account/deletion-pending-panel';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Account scheduled for deletion — HeyHenry',
};

export default async function DeletionPendingPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const tenant = await getCurrentTenant();
  if (!tenant) redirect('/login');

  // If the tenant isn't actually pending deletion, send them back to the
  // dashboard. (Direct hit on this URL after an abort, for example.)
  if (!tenant.deletedAt) redirect('/dashboard');

  // Look up the active request for the countdown + abort button.
  const admin = createAdminClient();
  const { data: request } = await admin
    .from('tenant_deletion_requests')
    .select('id, requested_at, effective_at, reason')
    .eq('tenant_id', tenant.id)
    .is('aborted_at', null)
    .order('requested_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <DeletionPendingPanel
        businessName={tenant.name}
        requestedAt={(request?.requested_at as string | undefined) ?? tenant.deletedAt}
        effectiveAt={(request?.effective_at as string | undefined) ?? null}
        isOwner={tenant.member.role === 'owner'}
      />
    </div>
  );
}
