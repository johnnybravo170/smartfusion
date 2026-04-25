/**
 * Public landing page for SMS / email tap-to-decide links. Slice 3 of
 * the Customer Portal build (with Slice 7 being the SMS sender that
 * uses these links).
 *
 * Mirrors /approve/<code> for change orders. The homeowner taps a link
 * from their phone, sees the decision context + reference photos, and
 * gets the same Approve / Decline / Ask buttons as on the portal —
 * without having to navigate to /portal/<slug>. No login.
 */

import { DecisionPanel, type PortalDecision } from '@/components/features/portal/decision-panel';
import { PublicViewLogger } from '@/components/features/public/public-view-logger';
import { createAdminClient } from '@/lib/supabase/admin';

export const metadata = {
  title: 'Decision Request — HeyHenry',
};

export default async function DecidePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const admin = createAdminClient();

  const { data: decision } = await admin
    .from('project_decisions')
    .select(
      `id, approval_code, label, description, due_date, status, photo_refs, options, decided_value,
       decided_by_customer, decided_at,
       projects:project_id (name, customers:customer_id (name)),
       tenants:tenant_id (name)`,
    )
    .eq('approval_code', code)
    .single();

  if (!decision) {
    return (
      <div className="mx-auto max-w-lg py-20 text-center">
        <h1 className="text-2xl font-semibold">Decision request not found</h1>
        <p className="mt-2 text-muted-foreground">This link may have expired or been dismissed.</p>
      </div>
    );
  }

  const d = decision as Record<string, unknown>;
  const project = d.projects as Record<string, unknown> | null;
  const tenant = d.tenants as Record<string, unknown> | null;
  const customer = project?.customers as Record<string, unknown> | null;
  const businessName = (tenant?.name as string) ?? 'Your Contractor';
  const projectName = (project?.name as string) ?? 'Project';
  const customerName = (customer?.name as string) ?? '';
  const status = d.status as string;

  // Already responded.
  if (status === 'decided') {
    const value = d.decided_value as string;
    const who = (d.decided_by_customer as string) ?? 'You';
    return (
      <div className="mx-auto max-w-lg py-20 text-center">
        <PublicViewLogger resourceType="decision" identifier={code} />
        <h1 className="text-2xl font-semibold">
          Already {value === 'approved' ? 'approved' : 'declined'}
        </h1>
        <p className="mt-2 text-muted-foreground">
          {who} {value} this on{' '}
          {new Date(d.decided_at as string).toLocaleDateString('en-CA', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          })}
          .
        </p>
      </div>
    );
  }
  if (status === 'dismissed') {
    return (
      <div className="mx-auto max-w-lg py-20 text-center">
        <h1 className="text-2xl font-semibold">No longer needed</h1>
        <p className="mt-2 text-muted-foreground">
          {businessName} dismissed this decision request.
        </p>
      </div>
    );
  }

  // Resolve photo refs.
  const refs = (d.photo_refs ?? []) as Array<{ storage_path?: string }>;
  const paths = refs.map((r) => r?.storage_path).filter((p): p is string => Boolean(p));
  const signedMap = new Map<string, string>();
  if (paths.length > 0) {
    const { data: signed } = await admin.storage.from('photos').createSignedUrls(paths, 3600);
    for (const row of signed ?? []) {
      if (row.path && row.signedUrl) signedMap.set(row.path, row.signedUrl);
    }
  }

  const optionsRaw = d.options as unknown[] | null;
  const options = Array.isArray(optionsRaw)
    ? optionsRaw.filter((o): o is string => typeof o === 'string')
    : [];

  const portalDecision: PortalDecision = {
    id: d.id as string,
    approval_code: d.approval_code as string,
    label: d.label as string,
    description: (d.description as string | null) ?? null,
    due_date: (d.due_date as string | null) ?? null,
    photo_urls: refs
      .map((r) => (r?.storage_path ? signedMap.get(r.storage_path) : null))
      .filter((u): u is string => Boolean(u)),
    options,
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <PublicViewLogger resourceType="decision" identifier={code} />
      <header className="mb-6 text-center">
        <p className="text-sm font-medium text-muted-foreground">{businessName}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{projectName}</h1>
      </header>
      <DecisionPanel decisions={[portalDecision]} defaultCustomerName={customerName} />
    </div>
  );
}
