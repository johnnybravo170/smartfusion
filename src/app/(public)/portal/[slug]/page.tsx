import { notFound } from 'next/navigation';
import { PhaseRail } from '@/components/features/portal/phase-rail';
import {
  type PortalGalleryPhoto,
  PortalPhotoGallery,
} from '@/components/features/portal/portal-photo-gallery';
import { PublicViewLogger } from '@/components/features/public/public-view-logger';
import type { ProjectPhase } from '@/lib/db/queries/project-phases';
import { createAdminClient } from '@/lib/supabase/admin';
import { isPortalPhotoTag, type PortalPhotoTag } from '@/lib/validators/portal-photo';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const admin = createAdminClient();
  const { data: project } = await admin
    .from('projects')
    .select('name, tenants:tenant_id (name)')
    .eq('portal_slug', slug)
    .eq('portal_enabled', true)
    .is('deleted_at', null)
    .single();

  if (!project) return { title: 'Project Portal — HeyHenry' };
  const tenant = (project as Record<string, unknown>).tenants as Record<string, unknown> | null;
  return {
    title: `${project.name} — ${(tenant?.name as string) ?? 'HeyHenry'}`,
  };
}

export default async function PortalPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const admin = createAdminClient();

  // Load project + tenant + customer
  const { data: project } = await admin
    .from('projects')
    .select(
      `id, name, lifecycle_stage, percent_complete, start_date, target_end_date,
       portal_slug, portal_enabled,
       tenants:tenant_id (name),
       customers:customer_id (name)`,
    )
    .eq('portal_slug', slug)
    .eq('portal_enabled', true)
    .is('deleted_at', null)
    .single();

  if (!project) notFound();

  const p = project as Record<string, unknown>;
  const tenant = p.tenants as Record<string, unknown> | null;
  const customer = p.customers as Record<string, unknown> | null;
  const businessName = (tenant?.name as string) ?? 'Your Contractor';
  const customerName = (customer?.name as string) ?? '';
  const projectId = p.id as string;
  const percentComplete = (p.percent_complete as number) ?? 0;

  // Load homeowner-facing phase rail (Slice 1 of Customer Portal build).
  // Admin client bypasses RLS — phases inherit visibility from the
  // already-authorized portal slug check above.
  const { data: phaseRows } = await admin
    .from('project_phases')
    .select('id, project_id, name, display_order, status, started_at, completed_at')
    .eq('project_id', projectId)
    .order('display_order', { ascending: true });
  const phases = (phaseRows ?? []) as ProjectPhase[];

  // Load portal updates
  const { data: updates } = await admin
    .from('project_portal_updates')
    .select('id, type, title, body, photo_url, photo_storage_path, created_at')
    .eq('project_id', projectId)
    .eq('is_visible', true)
    .order('created_at', { ascending: false })
    .limit(50);

  // Load pending change orders for the approvals section
  const { data: pendingCOs } = await admin
    .from('change_orders')
    .select('id, title, cost_impact_cents, timeline_impact_days, approval_code, status')
    .eq('project_id', projectId)
    .eq('status', 'pending_approval');

  // Load approved change order totals for financials
  const { data: approvedCOs } = await admin
    .from('change_orders')
    .select('cost_impact_cents')
    .eq('project_id', projectId)
    .eq('status', 'approved');

  const approvedCOTotal = (approvedCOs ?? []).reduce(
    (sum, row) => sum + ((row as Record<string, unknown>).cost_impact_cents as number),
    0,
  );

  // Load original budget estimate
  const { data: buckets } = await admin
    .from('project_cost_buckets')
    .select('estimate_cents')
    .eq('project_id', projectId);

  const originalEstimate = (buckets ?? []).reduce(
    (sum, row) => sum + ((row as Record<string, unknown>).estimate_cents as number),
    0,
  );

  const totalBudget = originalEstimate + approvedCOTotal;

  // Slice 2 — homeowner photo gallery from operator-tagged photos. Pulls
  // from the photos table where the operator has set portal_tags AND
  // left client_visible=true. Separate from `project_portal_updates`
  // photos which are inline updates rather than gallery entries.
  const { data: galleryRows } = await admin
    .from('photos')
    .select('id, storage_path, caption, portal_tags')
    .eq('project_id', projectId)
    .eq('client_visible', true)
    .is('deleted_at', null)
    .not('portal_tags', 'eq', '{}')
    .order('taken_at', { ascending: false, nullsFirst: false })
    .order('uploaded_at', { ascending: false })
    .limit(200);

  const galleryPaths = (galleryRows ?? [])
    .map((r) => (r as Record<string, unknown>).storage_path as string)
    .filter(Boolean);
  const gallerySignedMap = new Map<string, string>();
  if (galleryPaths.length > 0) {
    const { data: signed } = await admin.storage
      .from('photos')
      .createSignedUrls(galleryPaths, 3600);
    for (const row of signed ?? []) {
      if (row.path && row.signedUrl) gallerySignedMap.set(row.path, row.signedUrl);
    }
  }
  const galleryPhotos: PortalGalleryPhoto[] = (galleryRows ?? [])
    .map((r) => {
      const row = r as Record<string, unknown>;
      const url = gallerySignedMap.get(row.storage_path as string);
      if (!url) return null;
      const tags = (row.portal_tags as string[] | null) ?? [];
      const validTags = tags.filter(isPortalPhotoTag) as PortalPhotoTag[];
      if (validTags.length === 0) return null;
      return {
        id: row.id as string,
        url,
        caption: (row.caption as string | null) ?? null,
        tags: validTags,
      };
    })
    .filter((p): p is PortalGalleryPhoto => p !== null);

  // Sign portal update photo storage paths (private photos bucket).
  const photoPaths = (updates ?? [])
    .map((u) => (u as Record<string, unknown>).photo_storage_path as string | null)
    .filter((p): p is string => !!p);
  const photoSignedUrls = new Map<string, string>();
  if (photoPaths.length > 0) {
    const { data: signed } = await admin.storage.from('photos').createSignedUrls(photoPaths, 3600);
    for (const row of signed ?? []) {
      if (row.path && row.signedUrl) photoSignedUrls.set(row.path, row.signedUrl);
    }
  }

  // Group updates by date
  const updatesByDate = new Map<string, typeof updates>();
  for (const u of updates ?? []) {
    const dateKey = new Date(
      (u as Record<string, unknown>).created_at as string,
    ).toLocaleDateString('en-CA', { month: 'long', day: 'numeric', year: 'numeric' });
    const existing = updatesByDate.get(dateKey) ?? [];
    existing.push(u);
    updatesByDate.set(dateKey, existing);
  }

  const cadFormat = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

  const typeIcons: Record<string, string> = {
    progress: 'bg-blue-100 text-blue-700',
    photo: 'bg-purple-100 text-purple-700',
    milestone: 'bg-emerald-100 text-emerald-700',
    message: 'bg-amber-100 text-amber-700',
    system: 'bg-gray-100 text-gray-600',
  };

  const statusLabel =
    p.lifecycle_stage === 'active'
      ? 'Active'
      : p.lifecycle_stage === 'awaiting_approval'
        ? 'Awaiting approval'
        : p.lifecycle_stage === 'planning'
          ? 'Planning'
          : p.lifecycle_stage === 'on_hold'
            ? 'On hold'
            : p.lifecycle_stage === 'complete'
              ? 'Complete'
              : (p.lifecycle_stage as string);

  const hasPendingItems = (pendingCOs ?? []).length > 0;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <PublicViewLogger resourceType="portal" identifier={slug} />
      {/* Header */}
      <header className="mb-8 text-center">
        <p className="text-sm font-medium text-muted-foreground">{businessName}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{p.name as string}</h1>
        {customerName ? <p className="mt-1 text-sm text-muted-foreground">{customerName}</p> : null}
      </header>

      {/* Phase rail — homeowner-facing milestone tracker. Read-only here;
          operator advances/regresses from the project detail Portal tab. */}
      {phases.length > 0 ? (
        <div className="mb-8">
          <PhaseRail phases={phases} />
        </div>
      ) : null}

      {/* Status bar */}
      <div className="mb-8 rounded-lg border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <span className="inline-flex items-center rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-800">
              {statusLabel}
            </span>
          </div>
          {hasPendingItems ? (
            <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
              Waiting on you
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800">
              Waiting on us
            </span>
          )}
        </div>

        {/* Progress bar */}
        <div>
          <div className="mb-1 flex justify-between text-xs text-muted-foreground">
            <span>Progress</span>
            <span>{percentComplete}%</span>
          </div>
          <div className="h-2 w-full rounded-full bg-gray-100">
            <div
              className="h-2 rounded-full bg-primary transition-all"
              style={{ width: `${percentComplete}%` }}
            />
          </div>
        </div>
      </div>

      {/* Pending Approvals */}
      {(pendingCOs ?? []).length > 0 ? (
        <div className="mb-8">
          <h2 className="mb-3 text-sm font-semibold">Needs Your Approval</h2>
          <div className="space-y-2">
            {(pendingCOs ?? []).map((co) => {
              const coRow = co as Record<string, unknown>;
              const costCents = coRow.cost_impact_cents as number;
              return (
                <a
                  key={coRow.id as string}
                  href={`/approve/${coRow.approval_code}`}
                  className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 p-3 hover:bg-amber-100 transition-colors"
                >
                  <span className="text-sm font-medium">{coRow.title as string}</span>
                  <span className="text-sm tabular-nums">
                    {costCents >= 0 ? '+' : ''}
                    {cadFormat.format(costCents / 100)}
                  </span>
                </a>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Financials summary */}
      <div className="mb-8 grid grid-cols-3 gap-3">
        <div className="rounded-lg border p-3 text-center">
          <p className="text-xs text-muted-foreground">Original Estimate</p>
          <p className="text-sm font-semibold tabular-nums">
            {cadFormat.format(originalEstimate / 100)}
          </p>
        </div>
        <div className="rounded-lg border p-3 text-center">
          <p className="text-xs text-muted-foreground">Change Orders</p>
          <p className="text-sm font-semibold tabular-nums">
            {approvedCOTotal >= 0 ? '+' : ''}
            {cadFormat.format(approvedCOTotal / 100)}
          </p>
        </div>
        <div className="rounded-lg border p-3 text-center">
          <p className="text-xs text-muted-foreground">Current Total</p>
          <p className="text-sm font-semibold tabular-nums">
            {cadFormat.format(totalBudget / 100)}
          </p>
        </div>
      </div>

      {/* Photo gallery — operator-tagged photos grouped by category.
          Behind-the-wall section is collapsed by default. */}
      {galleryPhotos.length > 0 ? (
        <div className="mb-8">
          <PortalPhotoGallery photos={galleryPhotos} />
        </div>
      ) : null}

      {/* Updates feed */}
      <div>
        <h2 className="mb-4 text-sm font-semibold">Updates</h2>
        {(updates ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">No updates yet.</p>
        ) : null}
        <div className="space-y-6">
          {Array.from(updatesByDate.entries()).map(([dateLabel, dateUpdates]) => (
            <div key={dateLabel}>
              <p className="mb-2 text-xs font-medium text-muted-foreground">{dateLabel}</p>
              <div className="space-y-3">
                {(dateUpdates ?? []).map((u) => {
                  const ud = u as Record<string, unknown>;
                  const uType = (ud.type as string) ?? 'system';
                  return (
                    <div key={ud.id as string} className="flex gap-3">
                      <div
                        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-medium ${typeIcons[uType] ?? typeIcons.system}`}
                      >
                        {uType === 'progress'
                          ? 'P'
                          : uType === 'photo'
                            ? 'Ph'
                            : uType === 'milestone'
                              ? 'M'
                              : uType === 'message'
                                ? 'Msg'
                                : 'S'}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{ud.title as string}</p>
                        {ud.body ? (
                          <p className="mt-0.5 text-sm text-muted-foreground whitespace-pre-wrap">
                            {ud.body as string}
                          </p>
                        ) : null}
                        {(() => {
                          const storagePath = ud.photo_storage_path as string | null;
                          const signed = storagePath ? photoSignedUrls.get(storagePath) : null;
                          const src = signed ?? (ud.photo_url as string | null);
                          return src ? (
                            // biome-ignore lint/performance/noImgElement: signed URLs bypass next/image optimizer
                            <img
                              src={src}
                              alt=""
                              className="mt-2 max-h-64 rounded-md object-cover"
                            />
                          ) : null;
                        })()}
                        <p className="mt-1 text-xs text-muted-foreground">
                          {new Date(ud.created_at as string).toLocaleTimeString('en-CA', {
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
