import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DecisionPanel, type PortalDecision } from '@/components/features/portal/decision-panel';
import { PhaseRail, type PhaseRailPhoto } from '@/components/features/portal/phase-rail';
import { PortalBudgetDetail } from '@/components/features/portal/portal-budget-detail';
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
import {
  PortalScheduleGantt,
  type PortalScheduleTaskView,
} from '@/components/features/portal/portal-schedule-gantt';
import { PortalSelectionsPanel } from '@/components/features/portal/portal-selections-panel';
import { TradeContactsList } from '@/components/features/portal/trade-contacts-list';
import { PublicViewLogger } from '@/components/features/public/public-view-logger';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { TenantProvider } from '@/lib/auth/tenant-context';
import {
  getPortalBudgetSummary,
  type PortalBudgetSummary,
  shouldShowPortalBudget,
} from '@/lib/db/queries/portal-budget';
import type { ProjectSubContact } from '@/lib/db/queries/project-documents';
import type { ProjectPhase } from '@/lib/db/queries/project-phases';
import type { ProjectSelection } from '@/lib/db/queries/project-selections';
import { signIdeaBoardImageUrls } from '@/lib/storage/idea-board';
import { createAdminClient } from '@/lib/supabase/admin';
import { isPortalPhotoTag, type PortalPhotoTag } from '@/lib/validators/portal-photo';
import type { IdeaBoardItem } from '@/server/actions/project-idea-board';
import type { MessageRow } from '@/server/actions/project-messages';

/**
 * Per-trade disruption warning copy shown under high-disruption tasks
 * on the customer portal Gantt. Trade-specific where it adds clarity;
 * the rest fall through to a generic "plan to be out" message.
 */
function disruptionWarningCopy(tradeSlug: string): string {
  switch (tradeSlug) {
    case 'demo':
      return 'Loud, dusty';
    case 'drywall':
      return 'Heavy dust during sanding';
    case 'tile':
      return 'Saw cuts — loud and dusty';
    case 'flooring':
      return 'Disruptive in occupied rooms';
    case 'painting':
      return 'Fumes — ventilate; you may want to be out';
    case 'plumbing_fixtures':
      return 'Water off during install';
    default:
      return 'Plan to be out — disruptive';
  }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const admin = createAdminClient();
  const { data: project } = await admin
    .from('projects')
    .select('name, tenants:tenant_id (name)')
    .eq('portal_slug', slug)
    .is('deleted_at', null)
    .single();

  if (!project) return { title: 'Project Portal — HeyHenry' };
  const tenant = (project as Record<string, unknown>).tenants as Record<string, unknown> | null;
  return {
    title: `${project.name} — ${(tenant?.name as string) ?? 'HeyHenry'}`,
    // Don't index preview pages, even though they 404 to non-operators.
    robots: { index: false, follow: false },
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
  const tab: 'project' | 'budget' | 'schedule' | 'messages' | 'ideas' | 'selections' | 'photos' =
    resolvedSearchParams.tab === 'messages'
      ? 'messages'
      : resolvedSearchParams.tab === 'ideas'
        ? 'ideas'
        : resolvedSearchParams.tab === 'selections'
          ? 'selections'
          : resolvedSearchParams.tab === 'photos'
            ? 'photos'
            : resolvedSearchParams.tab === 'budget'
              ? 'budget'
              : resolvedSearchParams.tab === 'schedule'
                ? 'schedule'
                : 'project';
  const admin = createAdminClient();

  // Load project + tenant + customer. We DON'T filter by portal_enabled
  // here — instead we resolve the project regardless and gate visibility
  // below. If portal is disabled, only an authed operator from the
  // owning tenant gets through (preview mode); otherwise 404.
  const { data: project } = await admin
    .from('projects')
    .select(
      `id, name, tenant_id, lifecycle_stage, percent_complete, start_date, target_end_date,
       portal_slug, portal_enabled, portal_show_budget,
       tenants:tenant_id (name, logo_storage_path, portal_show_budget, timezone),
       customers:customer_id (name)`,
    )
    .eq('portal_slug', slug)
    .is('deleted_at', null)
    .single();

  if (!project) notFound();

  // Operator-preview gate. Public visitors only see the portal when
  // portal_enabled is true. Operators on the owning tenant can preview
  // even when disabled — they get a banner indicating that.
  const portalEnabledLive = Boolean((project as Record<string, unknown>).portal_enabled);
  const projectTenantId = (project as Record<string, unknown>).tenant_id as string;
  let isOperatorPreview = false;
  if (!portalEnabledLive) {
    const operatorTenant = await getCurrentTenant().catch(() => null);
    if (operatorTenant && operatorTenant.id === projectTenantId) {
      isOperatorPreview = true;
    } else {
      notFound();
    }
  }

  const p = project as Record<string, unknown>;
  const portalTenantNode = p.tenants as
    | { timezone?: string | null }
    | { timezone?: string | null }[]
    | null;
  const portalTenantObj = Array.isArray(portalTenantNode) ? portalTenantNode[0] : portalTenantNode;
  const tenantTz = portalTenantObj?.timezone ?? undefined;
  const tenant = p.tenants as Record<string, unknown> | null;
  const customer = p.customers as Record<string, unknown> | null;
  const businessName = (tenant?.name as string) ?? 'Your Contractor';
  const customerName = (customer?.name as string) ?? '';
  const projectId = p.id as string;

  const lifecycleStage = (p.lifecycle_stage as string) ?? 'planning';

  // Sign tenant logo + load Messages-tab unread count. Both run on every
  // tab — the logo is in the page header and the unread badge sits in
  // the tab nav. Everything else loads only on its owning tab.
  const logoStoragePath = (tenant?.logo_storage_path as string | null) ?? null;
  const portalShowBudget = shouldShowPortalBudget(
    p.portal_show_budget as boolean | null | undefined,
    tenant?.portal_show_budget as boolean | null | undefined,
  );

  const [logoSignRes, unreadRes] = await Promise.all([
    logoStoragePath
      ? admin.storage.from('photos').createSignedUrl(logoStoragePath, 3600)
      : Promise.resolve({ data: null as { signedUrl: string } | null }),
    admin
      .from('project_messages')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('direction', 'outbound')
      .is('read_by_customer_at', null),
  ]);
  const logoUrl = logoSignRes.data?.signedUrl ?? null;
  const unreadFromBusiness = unreadRes.count ?? 0;

  // Per-tab data — populated only for the active tab so non-active tabs
  // don't pay for queries the user can't see. Within each tab the row
  // queries fan out via Promise.all; storage signing follows in a single
  // second round so the worst case is two sequential round-trips.
  let percentComplete = 0;
  let phases: ProjectPhase[] = [];
  let phasePhotos: PhaseRailPhoto[] = [];
  let updates: Array<Record<string, unknown>> = [];
  const updatesByDate = new Map<string, Array<Record<string, unknown>>>();
  const photoSignedUrls = new Map<string, string>();
  let pendingCOs: Array<Record<string, unknown>> = [];
  let portalDecisions: PortalDecision[] = [];
  let tradeContacts: ProjectSubContact[] = [];
  let portalDocuments: PortalDocument[] = [];

  let originalEstimate = 0;
  let approvedCOTotal = 0;
  let totalBudget = 0;
  let portalBudgetSummary: PortalBudgetSummary = {
    categories: [],
    project_total_cents: 0,
    project_spent_cents: 0,
    draws_invoiced_cents: 0,
    draws_paid_cents: 0,
    has_draws: false,
    customer_contract_total_cents: 0,
    tax_label: '',
  };

  let galleryPhotos: PortalGalleryPhoto[] = [];

  let selectionsForPanel: Array<ProjectSelection & { image_url: string | null }> = [];
  let initialIdeaItems: IdeaBoardItem[] = [];
  let roomSuggestions: string[] = [];

  let initialMessages: MessageRow[] = [];

  let scheduleTasks: PortalScheduleTaskView[] = [];

  if (tab === 'project') {
    // Round 1: kick off every row query in parallel.
    const burnRunning = lifecycleStage !== 'complete' && lifecycleStage !== 'cancelled';
    const [
      linesRes,
      billsRes,
      expensesRes,
      phaseRowsRes,
      phasePhotoRowsRes,
      updatesRes,
      pendingCOsRes,
      decisionRowsRes,
      subDocRowsRes,
      docRowsRes,
    ] = await Promise.all([
      burnRunning
        ? admin.from('project_cost_lines').select('line_price_cents').eq('project_id', projectId)
        : Promise.resolve({ data: [] as Array<{ line_price_cents: number }> }),
      burnRunning
        ? admin.from('project_bills').select('amount_cents').eq('project_id', projectId)
        : Promise.resolve({ data: [] as Array<{ amount_cents: number }> }),
      burnRunning
        ? admin.from('expenses').select('amount_cents').eq('project_id', projectId)
        : Promise.resolve({ data: [] as Array<{ amount_cents: number }> }),
      admin
        .from('project_phases')
        .select('id, project_id, name, display_order, status, started_at, completed_at')
        .eq('project_id', projectId)
        .order('display_order', { ascending: true }),
      admin
        .from('photos')
        .select('id, phase_id, storage_path, caption, client_visible')
        .eq('project_id', projectId)
        .not('phase_id', 'is', null)
        .eq('client_visible', true)
        .is('deleted_at', null)
        .order('taken_at', { ascending: true, nullsFirst: false }),
      admin
        .from('project_portal_updates')
        .select('id, type, title, body, photo_url, photo_storage_path, created_at')
        .eq('project_id', projectId)
        .eq('is_visible', true)
        .order('created_at', { ascending: false })
        .limit(50),
      admin
        .from('change_orders')
        .select('id, title, cost_impact_cents, timeline_impact_days, approval_code, status')
        .eq('project_id', projectId)
        .eq('status', 'pending_approval'),
      admin
        .from('project_decisions')
        .select('id, approval_code, label, description, due_date, photo_refs, options')
        .eq('project_id', projectId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false }),
      admin
        .from('project_documents')
        .select('supplier_id')
        .eq('project_id', projectId)
        .is('deleted_at', null)
        .not('supplier_id', 'is', null),
      admin
        .from('project_documents')
        .select('id, type, title, storage_path, bytes, expires_at')
        .eq('project_id', projectId)
        .eq('client_visible', true)
        .is('deleted_at', null)
        .order('created_at', { ascending: false }),
    ]);

    if (lifecycleStage === 'complete') {
      percentComplete = 100;
    } else if (burnRunning) {
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

    phases = (phaseRowsRes.data ?? []) as ProjectPhase[];
    const phasePhotoRows = phasePhotoRowsRes.data ?? [];
    updates = (updatesRes.data ?? []) as Array<Record<string, unknown>>;
    pendingCOs = (pendingCOsRes.data ?? []) as Array<Record<string, unknown>>;
    const decisionRows = decisionRowsRes.data ?? [];
    const subDocRows = subDocRowsRes.data ?? [];
    const docRows = docRowsRes.data ?? [];

    const phasePhotoPaths = phasePhotoRows
      .map((r) => (r as Record<string, unknown>).storage_path as string)
      .filter(Boolean);

    const decisionPhotoPathSet = new Set<string>();
    for (const row of decisionRows) {
      const refs = ((row as Record<string, unknown>).photo_refs ?? []) as Array<{
        storage_path?: string;
      }>;
      for (const r of refs) if (r?.storage_path) decisionPhotoPathSet.add(r.storage_path);
    }

    const subIds = Array.from(
      new Set(
        subDocRows
          .map((r) => (r as Record<string, unknown>).supplier_id as string | null)
          .filter((id): id is string => Boolean(id)),
      ),
    );

    const docPaths = docRows
      .map((r) => (r as Record<string, unknown>).storage_path as string)
      .filter(Boolean);

    const updatePhotoPaths = updates
      .map((u) => (u as Record<string, unknown>).photo_storage_path as string | null)
      .filter((path): path is string => Boolean(path));

    // Round 2: sign every storage path + look up trade contacts in parallel.
    const [phasePhotoSignedRes, decisionSignedRes, docSignedRes, updateSignedRes, subContactsRes] =
      await Promise.all([
        phasePhotoPaths.length > 0
          ? admin.storage.from('photos').createSignedUrls(phasePhotoPaths, 3600)
          : Promise.resolve({ data: [] as Array<{ path: string | null; signedUrl: string }> }),
        decisionPhotoPathSet.size > 0
          ? admin.storage.from('photos').createSignedUrls(Array.from(decisionPhotoPathSet), 3600)
          : Promise.resolve({ data: [] as Array<{ path: string | null; signedUrl: string }> }),
        docPaths.length > 0
          ? admin.storage.from('project-docs').createSignedUrls(docPaths, 3600)
          : Promise.resolve({ data: [] as Array<{ path: string | null; signedUrl: string }> }),
        updatePhotoPaths.length > 0
          ? admin.storage.from('photos').createSignedUrls(updatePhotoPaths, 3600)
          : Promise.resolve({ data: [] as Array<{ path: string | null; signedUrl: string }> }),
        subIds.length > 0
          ? admin
              .from('customers')
              .select('id, name, kind, email, phone')
              .in('id', subIds)
              .is('deleted_at', null)
          : Promise.resolve({ data: [] as ProjectSubContact[] }),
      ]);

    const phasePhotoSignedMap = new Map<string, string>();
    for (const row of phasePhotoSignedRes.data ?? []) {
      if (row.path && row.signedUrl) phasePhotoSignedMap.set(row.path, row.signedUrl);
    }
    phasePhotos = phasePhotoRows
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
      .filter((ph): ph is PhaseRailPhoto => ph !== null);

    const decisionSignedMap = new Map<string, string>();
    for (const row of decisionSignedRes.data ?? []) {
      if (row.path && row.signedUrl) decisionSignedMap.set(row.path, row.signedUrl);
    }
    portalDecisions = decisionRows
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

    const docSignedMap = new Map<string, string>();
    for (const row of docSignedRes.data ?? []) {
      if (row.path && row.signedUrl) docSignedMap.set(row.path, row.signedUrl);
    }
    portalDocuments = docRows
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

    for (const row of updateSignedRes.data ?? []) {
      if (row.path && row.signedUrl) photoSignedUrls.set(row.path, row.signedUrl);
    }

    tradeContacts = ((subContactsRes.data ?? []) as unknown as ProjectSubContact[])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));

    const dayKeyFmt = new Intl.DateTimeFormat('en-CA', {
      dateStyle: 'long',
      timeZone: tenantTz ?? 'America/Vancouver',
    });
    for (const u of updates) {
      const dateKey = dayKeyFmt.format(new Date(u.created_at as string));
      const existing = updatesByDate.get(dateKey) ?? [];
      existing.push(u);
      updatesByDate.set(dateKey, existing);
    }
  } else if (tab === 'budget') {
    // Snapshot + approved CO sum + per-bucket breakdown — all in parallel.
    // The snapshot fallback (live cost-line sum) is rare and stays sequential.
    const [originalSnapRes, approvedCOsRes, budgetSummary] = await Promise.all([
      admin
        .from('project_scope_snapshots')
        .select('total_cents')
        .eq('project_id', projectId)
        .order('version_number', { ascending: true })
        .limit(1)
        .maybeSingle(),
      admin
        .from('change_orders')
        .select('cost_impact_cents')
        .eq('project_id', projectId)
        .eq('status', 'approved'),
      getPortalBudgetSummary(admin, projectId),
    ]);

    approvedCOTotal = (approvedCOsRes.data ?? []).reduce(
      (sum, row) => sum + ((row as Record<string, unknown>).cost_impact_cents as number),
      0,
    );

    originalEstimate =
      ((originalSnapRes.data as { total_cents?: number } | null)?.total_cents as
        | number
        | undefined) ?? 0;
    if (!originalSnapRes.data) {
      const { data: liveLines } = await admin
        .from('project_cost_lines')
        .select('line_price_cents')
        .eq('project_id', projectId);
      originalEstimate = (liveLines ?? []).reduce(
        (sum, row) => sum + ((row as { line_price_cents: number }).line_price_cents ?? 0),
        0,
      );
    }
    totalBudget = originalEstimate + approvedCOTotal;
    portalBudgetSummary = budgetSummary;
  } else if (tab === 'photos') {
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
    galleryPhotos = (galleryRows ?? [])
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
      .filter((ph): ph is PortalGalleryPhoto => ph !== null);
  } else if (tab === 'selections' || tab === 'ideas') {
    // Both tabs share roomSuggestions, the union of distinct rooms across
    // selections + idea-board items, so the composer dropdown stays
    // coherent regardless of which tab the customer is on.
    const [selectionRowsRes, ideaRowsRes] = await Promise.all([
      admin
        .from('project_selections')
        .select(
          'id, project_id, room, category, brand, name, code, finish, supplier, sku, warranty_url, notes, photo_refs, allowance_cents, actual_cost_cents, display_order, created_by, image_storage_path',
        )
        .eq('project_id', projectId)
        .order('room', { ascending: true })
        .order('display_order', { ascending: true }),
      admin
        .from('project_idea_board_items')
        .select(
          'id, project_id, customer_id, kind, image_storage_path, source_url, thumbnail_url, title, notes, room, read_by_operator_at, promoted_to_selection_id, promoted_at, created_at',
        )
        .eq('project_id', projectId)
        .order('created_at', { ascending: false }),
    ]);

    const selections: ProjectSelection[] = (
      (selectionRowsRes.data ?? []) as unknown as ProjectSelection[]
    ).map((row) => ({
      ...row,
      photo_refs: Array.isArray(row.photo_refs) ? row.photo_refs : [],
    }));

    const selectionPhotoPaths = new Set<string>();
    for (const sel of selections) {
      for (const r of sel.photo_refs) if (r.storage_path) selectionPhotoPaths.add(r.storage_path);
      if (sel.image_storage_path) selectionPhotoPaths.add(sel.image_storage_path);
    }

    const ideaItemsRaw = (ideaRowsRes.data ?? []) as IdeaBoardItem[];
    const ideaImagePaths = ideaItemsRaw
      .map((r) => r.image_storage_path)
      .filter((path): path is string => Boolean(path));

    const [selectionSignedRes, ideaSignedUrls] = await Promise.all([
      selectionPhotoPaths.size > 0
        ? admin.storage.from('photos').createSignedUrls(Array.from(selectionPhotoPaths), 3600)
        : Promise.resolve({ data: [] as Array<{ path: string | null; signedUrl: string }> }),
      signIdeaBoardImageUrls(admin, ideaImagePaths),
    ]);

    const selectionPhotoUrls = new Map<string, string>();
    for (const row of selectionSignedRes.data ?? []) {
      if (row.path && row.signedUrl) selectionPhotoUrls.set(row.path, row.signedUrl);
    }

    selectionsForPanel = selections.map((sel) => ({
      ...sel,
      image_url: sel.image_storage_path
        ? (selectionPhotoUrls.get(sel.image_storage_path) ?? null)
        : sel.photo_refs[0]?.storage_path
          ? (selectionPhotoUrls.get(sel.photo_refs[0].storage_path) ?? null)
          : null,
    }));

    initialIdeaItems = ideaItemsRaw.map((r) => ({
      ...r,
      image_url: r.image_storage_path ? (ideaSignedUrls.get(r.image_storage_path) ?? null) : null,
    }));

    roomSuggestions = Array.from(
      new Set(
        [
          ...selections.map((s) => s.room).filter((r): r is string => Boolean(r)),
          ...initialIdeaItems.map((i) => i.room).filter((r): r is string => Boolean(r)),
        ]
          .map((r) => r.trim())
          .filter(Boolean),
      ),
    ).sort((a, b) => a.localeCompare(b));
  } else if (tab === 'messages') {
    const { data: messageRows } = await admin
      .from('project_messages')
      .select(
        'id, sender_kind, sender_label, channel, direction, body, created_at, read_by_operator_at, read_by_customer_at',
      )
      .eq('project_id', projectId)
      .order('created_at', { ascending: true });
    initialMessages = (messageRows ?? []) as MessageRow[];
  } else if (tab === 'schedule') {
    // Customer-visible schedule rows + the small set of trade templates
    // they reference (for disruption warnings) + project_phases (for
    // phase-color-coded bars). Three flat selects, no PostgREST embed
    // — same robustness reasoning as the operator tab.
    const [{ data: taskRows }, { data: tradeRows }, { data: phaseRows }] = await Promise.all([
      admin
        .from('project_schedule_tasks')
        .select(
          'id, project_id, name, trade_template_id, budget_category_id, phase_id, planned_start_date, planned_duration_days, actual_start_date, actual_end_date, status, confidence, client_visible, display_order, notes',
        )
        .eq('project_id', projectId)
        .eq('client_visible', true)
        .is('deleted_at', null)
        .order('display_order', { ascending: true }),
      admin.from('trade_templates').select('id, slug, disruption_level, typical_phase'),
      admin.from('project_phases').select('id, name').eq('project_id', projectId),
    ]);
    const tradeById = new Map<
      string,
      { slug: string; disruption_level: string; typical_phase: string | null }
    >();
    for (const tr of tradeRows ?? []) {
      const r = tr as Record<string, unknown>;
      tradeById.set(r.id as string, {
        slug: r.slug as string,
        disruption_level: r.disruption_level as string,
        typical_phase: (r.typical_phase as string | null) ?? null,
      });
    }
    const phaseNameById = new Map<string, string>();
    for (const ph of phaseRows ?? []) {
      const r = ph as Record<string, unknown>;
      phaseNameById.set(r.id as string, r.name as string);
    }
    scheduleTasks = (taskRows ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      const tradeId = r.trade_template_id as string | null;
      const trade = tradeId ? tradeById.get(tradeId) : null;
      const phaseId = r.phase_id as string | null;
      // Phase color resolution: prefer the project's actual phase name
      // (matches the customer's phase-rail vocabulary), fall back to the
      // trade template's canonical typical_phase when the project uses
      // custom phase names that don't match the seeded color keys.
      const phaseName =
        (phaseId ? phaseNameById.get(phaseId) : null) ?? trade?.typical_phase ?? null;
      return {
        ...(r as unknown as PortalScheduleTaskView),
        warning: trade?.disruption_level === 'high' ? disruptionWarningCopy(trade.slug) : null,
        phaseName,
      };
    });
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
    <TenantProvider timezone={tenantTz ?? 'America/Vancouver'}>
      <div className="mx-auto max-w-4xl px-4 py-8">
        {isOperatorPreview ? (
          <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <strong>Preview mode.</strong> The portal is currently disabled — your customer
            can&rsquo;t see this page. Turn the toggle on from the project&rsquo;s Portal tab to
            share with them.
          </div>
        ) : (
          <PublicViewLogger resourceType="portal" identifier={slug} />
        )}
        {/* Header */}
        <header className="mb-8 text-center">
          {logoUrl ? (
            // Container gives every contractor's logo the same visual mass
            // regardless of aspect — square badges, wide wordmarks, and tall
            // crests all fill h-16 / max-w-[260px] without distortion.
            <div className="mx-auto mb-3 flex h-20 max-w-[280px] items-center justify-center">
              {/* biome-ignore lint/performance/noImgElement: signed URL bypasses next/image */}
              <img
                src={logoUrl}
                alt={businessName}
                className="max-h-full max-w-full object-contain"
              />
            </div>
          ) : (
            <p className="text-sm font-medium text-muted-foreground">{businessName}</p>
          )}
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{p.name as string}</h1>
          {customerName ? (
            <p className="mt-1 text-sm text-muted-foreground">{customerName}</p>
          ) : null}
        </header>

        {/* Tab nav — Project / Budget / Photos / Selections / Ideas / Messages. */}
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
            href={`/portal/${slug}?tab=budget`}
            prefetch={false}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === 'budget'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:border-gray-300 hover:text-foreground'
            }`}
          >
            Budget
          </Link>
          <Link
            href={`/portal/${slug}?tab=schedule`}
            prefetch={false}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === 'schedule'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:border-gray-300 hover:text-foreground'
            }`}
          >
            Schedule
          </Link>
          <Link
            href={`/portal/${slug}?tab=photos`}
            prefetch={false}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === 'photos'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:border-gray-300 hover:text-foreground'
            }`}
          >
            Photos
          </Link>
          <Link
            href={`/portal/${slug}?tab=selections`}
            prefetch={false}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === 'selections'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:border-gray-300 hover:text-foreground'
            }`}
          >
            Selections
          </Link>
          <Link
            href={`/portal/${slug}?tab=ideas`}
            prefetch={false}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === 'ideas'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:border-gray-300 hover:text-foreground'
            }`}
          >
            Ideas
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
        ) : tab === 'selections' ? (
          <PortalSelectionsPanel
            portalSlug={slug}
            initialSelections={selectionsForPanel}
            roomSuggestions={roomSuggestions}
          />
        ) : tab === 'photos' ? (
          galleryPhotos.length > 0 ? (
            <PortalPhotoGallery photos={galleryPhotos} />
          ) : (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No photos yet. Your contractor will add them as work progresses.
            </p>
          )
        ) : tab === 'budget' ? (
          <>
            {/* Three-number summary always shows. The per-bucket breakdown
              below shows only when the operator has opted in via
              portal_show_budget. */}
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

            {portalBudgetSummary.customer_contract_total_cents > totalBudget ? (
              <p className="-mt-6 mb-8 text-center text-xs text-muted-foreground">
                Your contract total:{' '}
                <span className="font-medium text-foreground">
                  {cadFormat.format(portalBudgetSummary.customer_contract_total_cents / 100)}
                </span>{' '}
                (incl. management fee + {portalBudgetSummary.tax_label})
              </p>
            ) : null}

            {portalShowBudget ? <PortalBudgetDetail summary={portalBudgetSummary} /> : null}
          </>
        ) : tab === 'schedule' ? (
          scheduleTasks.length > 0 ? (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Dates are estimates and may shift. ⚠ marks days you may want to plan to be out.
              </p>
              <PortalScheduleGantt tasks={scheduleTasks} />
            </div>
          ) : (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No schedule yet. Your contractor will publish one as the project firms up.
            </p>
          )
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

            {/* Photo gallery moved to its own tab (`?tab=photos`).
          Selections moved to its own tab (`?tab=selections`) where the
          customer can both browse the operator-authored install spec and
          add their own picks. */}

            {/* Documents & warranties — permanent files. */}
            {portalDocuments.length > 0 ? (
              <div className="mb-8">
                <PortalDocuments
                  documents={portalDocuments}
                  timezone={tenantTz ?? 'America/Vancouver'}
                />
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
                                const signed = storagePath
                                  ? photoSignedUrls.get(storagePath)
                                  : null;
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
                                {new Intl.DateTimeFormat('en-CA', {
                                  hour: 'numeric',
                                  minute: '2-digit',
                                  timeZone: tenantTz ?? 'America/Vancouver',
                                }).format(new Date(ud.created_at as string))}
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
    </TenantProvider>
  );
}
