import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DecisionPanel, type PortalDecision } from '@/components/features/portal/decision-panel';
import { PhaseRail, type PhaseRailPhoto } from '@/components/features/portal/phase-rail';
import {
  type PortalDocument,
  PortalDocuments,
} from '@/components/features/portal/portal-documents';
import { PortalIdeaBoard } from '@/components/features/portal/portal-idea-board';
import { PortalMessagesPanel } from '@/components/features/portal/portal-messages-panel';
import {
  type PortalGalleryPhoto,
  PortalPhotoGallery,
} from '@/components/features/portal/portal-photo-gallery';
import { PortalSelections } from '@/components/features/portal/portal-selections';
import { TradeContactsList } from '@/components/features/portal/trade-contacts-list';
import { PublicViewLogger } from '@/components/features/public/public-view-logger';
import type { ProjectSubContact } from '@/lib/db/queries/project-documents';
import type { ProjectPhase } from '@/lib/db/queries/project-phases';
import { groupSelectionsByRoom, type ProjectSelection } from '@/lib/db/queries/project-selections';
import { signIdeaBoardImageUrls } from '@/lib/storage/idea-board';
import { createAdminClient } from '@/lib/supabase/admin';
import { isPortalPhotoTag, type PortalPhotoTag } from '@/lib/validators/portal-photo';
import type { IdeaBoardItem } from '@/server/actions/project-idea-board';
import type { MessageRow } from '@/server/actions/project-messages';

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

export default async function PortalPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const resolvedSearchParams = await searchParams;
  const tab: 'project' | 'messages' | 'ideas' =
    resolvedSearchParams.tab === 'messages'
      ? 'messages'
      : resolvedSearchParams.tab === 'ideas'
        ? 'ideas'
        : 'project';
  const admin = createAdminClient();

  // Load project + tenant + customer
  const { data: project } = await admin
    .from('projects')
    .select(
      `id, name, lifecycle_stage, percent_complete, start_date, target_end_date,
       portal_slug, portal_enabled,
       tenants:tenant_id (name, logo_storage_path),
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

  // Derived "% complete" — same rule as the rest of the app:
  // - lifecycle 'complete' → 100
  // - lifecycle 'cancelled' → 0
  // - else → cost-to-cost capped at 99 (final paint/punchlist doesn't add
  //   cost, so the work isn't actually done until lifecycle flips).
  // Manual `percent_complete` column is no longer used.
  const lifecycleStage = (p.lifecycle_stage as string) ?? 'planning';
  let percentComplete = 0;
  if (lifecycleStage === 'complete') {
    percentComplete = 100;
  } else if (lifecycleStage !== 'cancelled') {
    const [linesRes, billsRes, expensesRes] = await Promise.all([
      admin.from('project_cost_lines').select('line_price_cents').eq('project_id', projectId),
      admin.from('project_bills').select('amount_cents').eq('project_id', projectId),
      admin.from('expenses').select('amount_cents').eq('project_id', projectId),
    ]);
    const est = (linesRes.data ?? []).reduce(
      (s, r) => s + ((r as { line_price_cents: number }).line_price_cents ?? 0),
      0,
    );
    const bills = (billsRes.data ?? []).reduce(
      (s, r) => s + ((r as { amount_cents: number }).amount_cents ?? 0),
      0,
    );
    const exps = (expensesRes.data ?? []).reduce(
      (s, r) => s + ((r as { amount_cents: number }).amount_cents ?? 0),
      0,
    );
    const burn = est > 0 ? ((bills + exps) / est) * 100 : 0;
    percentComplete = Math.min(99, Math.round(burn));
  }

  // Sign the contractor logo (lives in the photos bucket, same
  // convention as the rest of the app's tenant logos).
  const logoStoragePath = (tenant?.logo_storage_path as string | null) ?? null;
  let logoUrl: string | null = null;
  if (logoStoragePath) {
    const { data: signedLogo } = await admin.storage
      .from('photos')
      .createSignedUrl(logoStoragePath, 3600);
    logoUrl = signedLogo?.signedUrl ?? null;
  }

  // Load homeowner-facing phase rail (Slice 1 of Customer Portal build).
  // Admin client bypasses RLS — phases inherit visibility from the
  // already-authorized portal slug check above.
  const { data: phaseRows } = await admin
    .from('project_phases')
    .select('id, project_id, name, display_order, status, started_at, completed_at')
    .eq('project_id', projectId)
    .order('display_order', { ascending: true });
  const phases = (phaseRows ?? []) as ProjectPhase[];

  // Phase-pinned photos for the expandable rail.
  const { data: phasePhotoRows } = await admin
    .from('photos')
    .select('id, phase_id, storage_path, caption, client_visible')
    .eq('project_id', projectId)
    .not('phase_id', 'is', null)
    .eq('client_visible', true)
    .is('deleted_at', null)
    .order('taken_at', { ascending: true, nullsFirst: false });

  const phasePhotoPaths = (phasePhotoRows ?? [])
    .map((r) => (r as Record<string, unknown>).storage_path as string)
    .filter(Boolean);
  const phasePhotoSignedMap = new Map<string, string>();
  if (phasePhotoPaths.length > 0) {
    const { data: signed } = await admin.storage
      .from('photos')
      .createSignedUrls(phasePhotoPaths, 3600);
    for (const row of signed ?? []) {
      if (row.path && row.signedUrl) phasePhotoSignedMap.set(row.path, row.signedUrl);
    }
  }
  const phasePhotos: PhaseRailPhoto[] = (phasePhotoRows ?? [])
    .map((r) => {
      const row = r as Record<string, unknown>;
      const url = phasePhotoSignedMap.get(row.storage_path as string);
      if (!url) return null;
      return {
        id: row.id as string,
        phase_id: row.phase_id as string,
        url,
        caption: (row.caption as string | null) ?? null,
      };
    })
    .filter((p): p is PhaseRailPhoto => p !== null);

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

  // "Original Estimate" = the v1 scope snapshot captured at customer
  // acceptance (immutable). Falls back to the live cost-lines sum if
  // no snapshot exists yet (e.g. portal previewed pre-send, or imported
  // projects that never had an acceptance event).
  // Reading project_budget_categories.estimate_cents was wrong: that
  // column is a per-category envelope/cap that drifts from cost_lines
  // on imports and non-CO edits, so the sum understates the estimate.
  const { data: originalSnap } = await admin
    .from('project_scope_snapshots')
    .select('total_cents')
    .eq('project_id', projectId)
    .order('version_number', { ascending: true })
    .limit(1)
    .maybeSingle();

  let originalEstimate =
    ((originalSnap as { total_cents?: number } | null)?.total_cents as number | undefined) ?? 0;
  if (!originalSnap) {
    const { data: liveLines } = await admin
      .from('project_cost_lines')
      .select('line_price_cents')
      .eq('project_id', projectId);
    originalEstimate = (liveLines ?? []).reduce(
      (sum, row) => sum + ((row as { line_price_cents: number }).line_price_cents ?? 0),
      0,
    );
  }

  const totalBudget = originalEstimate + approvedCOTotal;

  // Slice 3 — pending homeowner decisions for the queue panel.
  const { data: decisionRows } = await admin
    .from('project_decisions')
    .select('id, approval_code, label, description, due_date, photo_refs, options')
    .eq('project_id', projectId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  // Resolve photo refs to signed URLs.
  const decisionPhotoPaths = new Set<string>();
  for (const row of decisionRows ?? []) {
    const refs = ((row as Record<string, unknown>).photo_refs ?? []) as Array<{
      storage_path?: string;
    }>;
    for (const r of refs) if (r?.storage_path) decisionPhotoPaths.add(r.storage_path);
  }
  const decisionSignedMap = new Map<string, string>();
  if (decisionPhotoPaths.size > 0) {
    const { data: signed } = await admin.storage
      .from('photos')
      .createSignedUrls(Array.from(decisionPhotoPaths), 3600);
    for (const row of signed ?? []) {
      if (row.path && row.signedUrl) decisionSignedMap.set(row.path, row.signedUrl);
    }
  }
  const portalDecisions: PortalDecision[] = (decisionRows ?? [])
    .filter((r) => Boolean((r as Record<string, unknown>).approval_code))
    .map((r) => {
      const row = r as Record<string, unknown>;
      const refs = (row.photo_refs ?? []) as Array<{ storage_path?: string }>;
      const photoUrls = refs
        .map((ref) => (ref?.storage_path ? decisionSignedMap.get(ref.storage_path) : null))
        .filter((u): u is string => Boolean(u));
      const optionsRaw = row.options as unknown[] | null;
      const options = Array.isArray(optionsRaw)
        ? optionsRaw.filter((o): o is string => typeof o === 'string')
        : [];
      return {
        id: row.id as string,
        approval_code: row.approval_code as string,
        label: row.label as string,
        description: (row.description as string | null) ?? null,
        due_date: (row.due_date as string | null) ?? null,
        photo_urls: photoUrls,
        options,
      };
    });

  // Trade contacts — distinct supplier_ids on this project's docs.
  const { data: subDocRows } = await admin
    .from('project_documents')
    .select('supplier_id')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .not('supplier_id', 'is', null);
  const subIds = Array.from(
    new Set(
      (subDocRows ?? [])
        .map((r) => (r as Record<string, unknown>).supplier_id as string | null)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  let tradeContacts: ProjectSubContact[] = [];
  if (subIds.length > 0) {
    const { data: subContacts } = await admin
      .from('customers')
      .select('id, name, kind, email, phone')
      .in('id', subIds)
      .is('deleted_at', null);
    tradeContacts = ((subContacts ?? []) as unknown as ProjectSubContact[])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Slice 5 — documents & warranties (homeowner-visible only).
  const { data: docRows } = await admin
    .from('project_documents')
    .select('id, type, title, storage_path, bytes, expires_at')
    .eq('project_id', projectId)
    .eq('client_visible', true)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  const docPaths = (docRows ?? [])
    .map((r) => (r as Record<string, unknown>).storage_path as string)
    .filter(Boolean);
  const docSignedMap = new Map<string, string>();
  if (docPaths.length > 0) {
    const { data: signed } = await admin.storage
      .from('project-docs')
      .createSignedUrls(docPaths, 3600);
    for (const row of signed ?? []) {
      if (row.path && row.signedUrl) docSignedMap.set(row.path, row.signedUrl);
    }
  }
  const portalDocuments: PortalDocument[] = (docRows ?? [])
    .map((r) => {
      const row = r as Record<string, unknown>;
      const url = docSignedMap.get(row.storage_path as string);
      if (!url) return null;
      return {
        id: row.id as string,
        type: row.type as PortalDocument['type'],
        title: row.title as string,
        url,
        bytes: (row.bytes as number | null) ?? null,
        expires_at: (row.expires_at as string | null) ?? null,
      };
    })
    .filter((d): d is PortalDocument => d !== null);

  // Slice 4 — per-room material selections. Read-only on the portal.
  const { data: selectionRows } = await admin
    .from('project_selections')
    .select(
      'id, project_id, room, category, brand, name, code, finish, supplier, sku, warranty_url, notes, photo_refs, display_order',
    )
    .eq('project_id', projectId)
    .order('room', { ascending: true })
    .order('display_order', { ascending: true });
  const selections: ProjectSelection[] = (
    (selectionRows ?? []) as unknown as ProjectSelection[]
  ).map((row) => ({
    ...row,
    photo_refs: Array.isArray(row.photo_refs) ? row.photo_refs : [],
  }));
  const selectionGroups = groupSelectionsByRoom(selections);

  // Sign storage paths referenced by selection photo_refs.
  const selectionPhotoPaths = new Set<string>();
  for (const sel of selections) {
    for (const r of sel.photo_refs) if (r.storage_path) selectionPhotoPaths.add(r.storage_path);
  }
  const selectionPhotoUrls = new Map<string, string>();
  if (selectionPhotoPaths.size > 0) {
    const { data: signed } = await admin.storage
      .from('photos')
      .createSignedUrls(Array.from(selectionPhotoPaths), 3600);
    for (const row of signed ?? []) {
      if (row.path && row.signedUrl) selectionPhotoUrls.set(row.path, row.signedUrl);
    }
  }

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

  // Messages tab data — load thread + unread count (operator messages
  // the customer hasn't read yet) for the tab badge.
  const [{ data: messageRows }, { count: unreadFromBusinessRaw }] = await Promise.all([
    admin
      .from('project_messages')
      .select(
        'id, sender_kind, sender_label, channel, direction, body, created_at, read_by_operator_at, read_by_customer_at',
      )
      .eq('project_id', projectId)
      .order('created_at', { ascending: true }),
    admin
      .from('project_messages')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('direction', 'outbound')
      .is('read_by_customer_at', null),
  ]);
  const initialMessages = (messageRows ?? []) as MessageRow[];
  const unreadFromBusiness = unreadFromBusinessRaw ?? 0;

  // Idea board — customer-side scratchpad (CUSTOMER_IDEA_BOARD_PLAN.md
  // Phase 1). Loaded eagerly so the Ideas tab renders without a client
  // round-trip on first paint. No notification-firing reads here.
  const { data: ideaRows } = await admin
    .from('project_idea_board_items')
    .select(
      'id, project_id, customer_id, kind, image_storage_path, source_url, thumbnail_url, title, notes, room, read_by_operator_at, promoted_to_selection_id, promoted_at, created_at',
    )
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  const ideaItemsRaw = (ideaRows ?? []) as IdeaBoardItem[];
  const ideaImagePaths = ideaItemsRaw
    .map((r) => r.image_storage_path)
    .filter((p): p is string => Boolean(p));
  const ideaSignedUrls = await signIdeaBoardImageUrls(admin, ideaImagePaths);
  const initialIdeaItems: IdeaBoardItem[] = ideaItemsRaw.map((r) => ({
    ...r,
    image_url: r.image_storage_path ? (ideaSignedUrls.get(r.image_storage_path) ?? null) : null,
  }));

  // Room suggestions for the idea-board composer: combine distinct rooms
  // from existing selections + prior idea-board entries.
  const roomSuggestions = Array.from(
    new Set(
      [
        ...selections.map((s) => s.room).filter((r): r is string => Boolean(r)),
        ...initialIdeaItems.map((i) => i.room).filter((r): r is string => Boolean(r)),
      ]
        .map((r) => r.trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b));

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
        {logoUrl ? (
          // biome-ignore lint/performance/noImgElement: signed URL bypasses next/image
          <img
            src={logoUrl}
            alt={businessName}
            className="mx-auto mb-3 max-h-12 w-auto object-contain"
          />
        ) : (
          <p className="text-sm font-medium text-muted-foreground">{businessName}</p>
        )}
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{p.name as string}</h1>
        {customerName ? <p className="mt-1 text-sm text-muted-foreground">{customerName}</p> : null}
      </header>

      {/* Tab nav — Project / Messages / Ideas. Messages and Ideas are
          described in PROJECT_MESSAGING_PLAN.md and CUSTOMER_IDEA_BOARD_PLAN.md
          respectively. */}
      <div className="mb-6 flex gap-1 border-b">
        <Link
          href={`/portal/${slug}`}
          prefetch={false}
          className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
            tab === 'project'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:border-gray-300 hover:text-foreground'
          }`}
        >
          Project
        </Link>
        <Link
          href={`/portal/${slug}?tab=messages`}
          prefetch={false}
          className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
            tab === 'messages'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:border-gray-300 hover:text-foreground'
          }`}
        >
          Messages
          {tab !== 'messages' && unreadFromBusiness > 0 ? (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
              {unreadFromBusiness > 9 ? '9+' : unreadFromBusiness}
            </span>
          ) : null}
        </Link>
        <Link
          href={`/portal/${slug}?tab=ideas`}
          prefetch={false}
          className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
            tab === 'ideas'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:border-gray-300 hover:text-foreground'
          }`}
        >
          Ideas
        </Link>
      </div>

      {tab === 'messages' ? (
        <PortalMessagesPanel
          portalSlug={slug}
          initialMessages={initialMessages}
          customerName={customerName || 'You'}
          businessName={businessName}
        />
      ) : tab === 'ideas' ? (
        <PortalIdeaBoard
          portalSlug={slug}
          initialItems={initialIdeaItems}
          roomSuggestions={roomSuggestions}
        />
      ) : (
        <>
          {/* Decision queue — pinned to the top because urgent ask. */}
          <DecisionPanel decisions={portalDecisions} defaultCustomerName={customerName} />

          {/* Phase rail — homeowner-facing milestone tracker. Read-only here;
          operator advances/regresses from the project detail Portal tab. */}
          {phases.length > 0 ? (
            <div className="mb-8">
              <PhaseRail phases={phases} phasePhotos={phasePhotos} />
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

          {/* Selections — per-room material record. Foreshadows the Home
          Record handoff package by showing the data live. */}
          {selectionGroups.length > 0 ? (
            <div className="mb-8">
              <PortalSelections groups={selectionGroups} signedUrls={selectionPhotoUrls} />
            </div>
          ) : null}

          {/* Documents & warranties — permanent files. */}
          {portalDocuments.length > 0 ? (
            <div className="mb-8">
              <PortalDocuments documents={portalDocuments} />
            </div>
          ) : null}

          {/* Trade contacts — sub-trades + vendors who worked on the job */}
          {tradeContacts.length > 0 ? (
            <div className="mb-8">
              <TradeContactsList contacts={tradeContacts} heading="Trade contacts" />
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
        </>
      )}
    </div>
  );
}
