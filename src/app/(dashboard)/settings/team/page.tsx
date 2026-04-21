/**
 * Settings > Team page.
 *
 * Owner-only. Shows invite generation, active invites, and team member list.
 */

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { InviteWorkerCard } from '@/components/features/team/invite-worker-card';
import { InvitesTable } from '@/components/features/team/invites-table';
import { TeamMembersTable } from '@/components/features/team/team-members-table';
import { WorkerDefaultsCard } from '@/components/features/team/worker-defaults-card';
import { requireTenant } from '@/lib/auth/helpers';
import { requireRole } from '@/lib/auth/role-guard';
import { listTeamMembers } from '@/lib/db/queries/team';
import { listInvitesByTenantId } from '@/lib/db/queries/worker-invites';
import { createAdminClient } from '@/lib/supabase/admin';

export default async function TeamPage() {
  const { tenant } = await requireTenant();
  requireRole(tenant, ['owner', 'admin']);

  const admin = createAdminClient();
  const [membersResult, invites, tenantRow] = await Promise.all([
    listTeamMembers(tenant.id),
    listInvitesByTenantId(tenant.id),
    admin
      .from('tenants')
      .select('workers_can_log_expenses, workers_can_invoice_default, workers_can_edit_old_entries')
      .eq('id', tenant.id)
      .single(),
  ]);
  const members = membersResult;
  const defaults = tenantRow.data;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <Link
          href="/settings"
          className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Settings
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
        <p className="text-sm text-muted-foreground">Invite workers and manage your team.</p>
      </div>

      <InviteWorkerCard />

      <WorkerDefaultsCard
        workersCanLogExpenses={defaults?.workers_can_log_expenses ?? true}
        workersCanInvoiceDefault={defaults?.workers_can_invoice_default ?? false}
        workersCanEditOldEntries={defaults?.workers_can_edit_old_entries ?? false}
      />

      <div className="space-y-3">
        <h2 className="text-lg font-medium">Invites</h2>
        <InvitesTable invites={invites} />
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-medium">Team Members</h2>
        <TeamMembersTable members={members} />
      </div>
    </div>
  );
}
