/**
 * Change order queries through the RLS-aware Supabase server client.
 */

import { createClient } from '@/lib/supabase/server';
import type { ChangeOrderStatus } from '@/lib/validators/change-order';

export type ChangeOrderRow = {
  id: string;
  project_id: string | null;
  job_id: string | null;
  tenant_id: string;
  title: string;
  description: string;
  reason: string | null;
  cost_impact_cents: number;
  timeline_impact_days: number;
  affected_buckets: string[];
  cost_breakdown: { budget_category_id: string; amount_cents: number }[];
  category_notes: { budget_category_id: string; note: string }[];
  applied_at: string | null;
  apply_warnings: { code: string; message: string; affected_id?: string }[];
  flow_version: 1 | 2;
  /** Per-CO management fee rate. NULL = inherit projects.management_fee_rate. */
  management_fee_override_rate: number | null;
  /** Operator-recorded reason when overriding the project default. */
  management_fee_override_reason: string | null;
  status: ChangeOrderStatus;
  approval_code: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  declined_at: string | null;
  declined_reason: string | null;
  approval_method: string | null;
  approved_by_member_id: string | null;
  approval_proof_paths: string[];
  approval_notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

const CO_COLUMNS =
  'id, project_id, job_id, tenant_id, title, description, reason, cost_impact_cents, timeline_impact_days, affected_buckets, cost_breakdown, category_notes, applied_at, apply_warnings, flow_version, management_fee_override_rate, management_fee_override_reason, status, approval_code, approved_by_name, approved_at, declined_at, declined_reason, approval_method, approved_by_member_id, approval_proof_paths, approval_notes, created_by, created_at, updated_at';

export type ChangeOrderLineRow = {
  id: string;
  change_order_id: string;
  action: 'add' | 'modify' | 'remove' | 'modify_envelope';
  original_line_id: string | null;
  budget_category_id: string | null;
  category: string | null;
  label: string | null;
  qty: number | null;
  unit: string | null;
  unit_cost_cents: number | null;
  unit_price_cents: number | null;
  line_cost_cents: number | null;
  line_price_cents: number | null;
  notes: string | null;
  before_snapshot: Record<string, unknown> | null;
};

export async function listChangeOrderLines(changeOrderId: string): Promise<ChangeOrderLineRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('change_order_lines')
    .select(
      'id, change_order_id, action, original_line_id, budget_category_id, category, label, qty, unit, unit_cost_cents, unit_price_cents, line_cost_cents, line_price_cents, notes, before_snapshot',
    )
    .eq('change_order_id', changeOrderId)
    .order('created_at', { ascending: true });
  return (data ?? []) as ChangeOrderLineRow[];
}

/**
 * Tenant-wide pending-approval change orders for the owner dashboard.
 * Joins through the job to surface the customer name in the listing.
 */
export async function listPendingChangeOrdersForDashboard(): Promise<
  Array<{ id: string; job_id: string | null; total_cents: number; customer_name: string | null }>
> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('change_orders')
    .select('id, job_id, cost_impact_cents, status, jobs:job_id (id, customers:customer_id (name))')
    .eq('status', 'pending_approval')
    .order('created_at', { ascending: false })
    .limit(20);

  return (data ?? []).map((row) => {
    const jobObj = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs;
    const customerObj = jobObj
      ? Array.isArray(jobObj.customers)
        ? jobObj.customers[0]
        : jobObj.customers
      : null;
    return {
      id: row.id as string,
      job_id: (row.job_id as string | null) ?? null,
      total_cents: (row.cost_impact_cents as number) ?? 0,
      customer_name: (customerObj?.name as string | undefined) ?? null,
    };
  });
}

export async function listChangeOrders(
  scope: { projectId: string } | { jobId: string },
): Promise<ChangeOrderRow[]> {
  const supabase = await createClient();
  let query = supabase
    .from('change_orders')
    .select(CO_COLUMNS)
    .order('created_at', { ascending: false });

  if ('projectId' in scope) {
    query = query.eq('project_id', scope.projectId);
  } else {
    query = query.eq('job_id', scope.jobId);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to list change orders: ${error.message}`);
  }
  return (data ?? []) as ChangeOrderRow[];
}

export async function getChangeOrder(id: string): Promise<ChangeOrderRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('change_orders')
    .select(CO_COLUMNS)
    .eq('id', id)
    .maybeSingle();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to load change order: ${error.message}`);
  }
  return (data as ChangeOrderRow) ?? null;
}

export async function getChangeOrderSummaryForProject(projectId: string): Promise<{
  approved_cost_cents: number;
  pending_cost_cents: number;
  approved_timeline_days: number;
  pending_timeline_days: number;
  pending_count: number;
}> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('change_orders')
    .select('status, cost_impact_cents, timeline_impact_days')
    .eq('project_id', projectId)
    .in('status', ['approved', 'pending_approval']);

  if (error) {
    throw new Error(`Failed to get change order summary: ${error.message}`);
  }

  let approved_cost_cents = 0;
  let pending_cost_cents = 0;
  let approved_timeline_days = 0;
  let pending_timeline_days = 0;
  let pending_count = 0;

  for (const row of data ?? []) {
    const r = row as { status: string; cost_impact_cents: number; timeline_impact_days: number };
    if (r.status === 'approved') {
      approved_cost_cents += r.cost_impact_cents;
      approved_timeline_days += r.timeline_impact_days;
    } else {
      pending_cost_cents += r.cost_impact_cents;
      pending_timeline_days += r.timeline_impact_days;
      pending_count += 1;
    }
  }

  return {
    approved_cost_cents,
    pending_cost_cents,
    approved_timeline_days,
    pending_timeline_days,
    pending_count,
  };
}

/**
 * Per-line / per-category contribution map for applied (v2) change orders.
 *
 * v2 COs apply directly to project_cost_lines + project_budget_categories
 * on approval, so the Estimate / Budget views show the rolled-up state
 * by default. This query layers an audit lens on top: which CO each
 * applied line came from, and the cumulative budget delta per category.
 *
 * Only walks v2 COs with applied_at set. Pending or v1 COs aren't here.
 */
export type AppliedChangeOrderContribution = {
  co_id: string;
  co_title: string;
  co_short_id: string;
  applied_at: string;
  action: 'add' | 'modify' | 'remove' | 'modify_envelope';
  delta_cents: number;
};

export type ProjectChangeOrderContributions = {
  /** keyed by project_cost_lines.id (only `add` + `modify` rows; removed
   *  lines no longer exist in cost_lines so they don't surface here). */
  byLineId: Map<string, AppliedChangeOrderContribution[]>;
  /** keyed by budget_category_id — every CO touching the category lands
   *  here, including line-level adds/modifies and modify_envelope entries. */
  byCategoryId: Map<string, AppliedChangeOrderContribution[]>;
  /** Applied COs in apply-time order (oldest first). Used for the
   *  "Change Order history" panel on the Estimate tab. */
  appliedOrder: {
    id: string;
    title: string;
    short_id: string;
    applied_at: string;
    cost_impact_cents: number;
  }[];
  /** Every CO on the project (any status, any flow version) so the
   *  Revenue card can surface all of them with appropriate badges:
   *  - applied: v2 + applied_at set; folded into cost_lines.
   *  - approved_legacy: v1 approved, OR v2 approved but never applied
   *    (mid-rollout state). Customer signed off but cost_lines may not
   *    reflect it — operator needs to verify.
   *  - pending: status='pending_approval' — projection only.
   *  - other (draft, declined, voided): not shown in the card. */
  all: {
    id: string;
    title: string;
    short_id: string;
    cost_impact_cents: number;
    status: 'draft' | 'pending_approval' | 'approved' | 'declined' | 'voided';
    flow_version: 1 | 2;
    applied_at: string | null;
    approved_at: string | null;
    /** Per-CO management fee override. NULL = use project default. */
    management_fee_override_rate: number | null;
    management_fee_override_reason: string | null;
    /** Synthesized: what bucket should the UI render this in? */
    revenue_kind: 'applied' | 'approved_legacy' | 'pending' | 'other';
  }[];
};

export async function getProjectChangeOrderContributions(
  projectId: string,
): Promise<ProjectChangeOrderContributions> {
  const supabase = await createClient();

  // Pull every CO on the project so we can surface all of them with
  // appropriate badges. v1 / pending / approved-not-applied COs were
  // previously invisible in the audit lens.
  const { data: cosRaw } = await supabase
    .from('change_orders')
    .select(
      'id, title, status, flow_version, applied_at, approved_at, cost_impact_cents, management_fee_override_rate, management_fee_override_reason',
    )
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });

  const all = (
    (cosRaw ?? []) as {
      id: string;
      title: string;
      status: 'draft' | 'pending_approval' | 'approved' | 'declined' | 'voided';
      flow_version: 1 | 2;
      applied_at: string | null;
      approved_at: string | null;
      cost_impact_cents: number;
      management_fee_override_rate: number | null;
      management_fee_override_reason: string | null;
    }[]
  ).map((c) => {
    let revenue_kind: 'applied' | 'approved_legacy' | 'pending' | 'other';
    if (c.status === 'approved' && c.applied_at !== null) {
      revenue_kind = 'applied';
    } else if (c.status === 'approved') {
      revenue_kind = 'approved_legacy';
    } else if (c.status === 'pending_approval') {
      revenue_kind = 'pending';
    } else {
      revenue_kind = 'other';
    }
    return {
      id: c.id,
      title: c.title,
      short_id: c.id.slice(0, 8),
      cost_impact_cents: c.cost_impact_cents,
      status: c.status,
      flow_version: c.flow_version,
      applied_at: c.applied_at,
      approved_at: c.approved_at,
      management_fee_override_rate: c.management_fee_override_rate,
      management_fee_override_reason: c.management_fee_override_reason,
      revenue_kind,
    };
  });

  const appliedOrder = all
    .filter((c) => c.revenue_kind === 'applied' && c.applied_at)
    // biome-ignore lint/style/noNonNullAssertion: filter guarantees applied_at non-null
    .sort((a, b) => a.applied_at!.localeCompare(b.applied_at!))
    .map((c) => ({
      id: c.id,
      title: c.title,
      short_id: c.short_id,
      applied_at: c.applied_at as string,
      cost_impact_cents: c.cost_impact_cents,
    }));

  const byLineId = new Map<string, AppliedChangeOrderContribution[]>();
  const byCategoryId = new Map<string, AppliedChangeOrderContribution[]>();

  if (appliedOrder.length === 0) return { byLineId, byCategoryId, appliedOrder, all };

  const coIds = appliedOrder.map((c) => c.id);
  const { data: lines } = await supabase
    .from('change_order_lines')
    .select(
      'id, change_order_id, action, original_line_id, budget_category_id, line_price_cents, before_snapshot',
    )
    .in('change_order_id', coIds);

  const coById = new Map(appliedOrder.map((c) => [c.id, c]));

  for (const raw of lines ?? []) {
    const r = raw as {
      action: 'add' | 'modify' | 'remove' | 'modify_envelope';
      change_order_id: string;
      original_line_id: string | null;
      budget_category_id: string | null;
      line_price_cents: number | null;
      before_snapshot: Record<string, unknown> | null;
    };
    const co = coById.get(r.change_order_id);
    if (!co) continue;

    const before = r.before_snapshot as {
      line_price_cents?: number;
      estimate_cents?: number;
    } | null;
    const isEnvelope = r.action === 'modify_envelope';
    const beforePrice = isEnvelope
      ? (before?.estimate_cents ?? 0)
      : (before?.line_price_cents ?? 0);
    const afterPrice = r.action === 'remove' ? 0 : (r.line_price_cents ?? 0);
    const delta = afterPrice - beforePrice;

    const contrib: AppliedChangeOrderContribution = {
      co_id: co.id,
      co_title: co.title,
      co_short_id: co.short_id,
      applied_at: co.applied_at,
      action: r.action,
      delta_cents: delta,
    };

    // Line-level: applied 'add' rows leave a new project_cost_lines row;
    // 'modify' rows mutate the original_line_id row in place. 'remove'
    // deletes the row so we can't anchor a chip to it.
    if (r.action === 'add' || r.action === 'modify') {
      const lineId = r.action === 'modify' ? r.original_line_id : null;
      if (lineId) {
        const arr = byLineId.get(lineId) ?? [];
        arr.push(contrib);
        byLineId.set(lineId, arr);
      }
    }

    // Category-level: every entry contributes to its category if present.
    if (r.budget_category_id) {
      const arr = byCategoryId.get(r.budget_category_id) ?? [];
      arr.push(contrib);
      byCategoryId.set(r.budget_category_id, arr);
    }
  }

  // 'add' rows don't have an original_line_id, but the inserted
  // project_cost_lines row gets the same label/qty/budget_category_id.
  // Look those up by matching budget_category_id + label so we can
  // attach chips to the new line. This is a best-effort match — if two
  // CO 'add' rows in the same category share a label, we'll hit both.
  const addRows = (
    (lines ?? []) as Array<{
      action: string;
      change_order_id: string;
      budget_category_id: string | null;
      label?: string | null;
      line_price_cents: number | null;
    }>
  ).filter((r) => r.action === 'add');

  if (addRows.length > 0) {
    const cats = Array.from(
      new Set(addRows.map((r) => r.budget_category_id).filter(Boolean)),
    ) as string[];
    if (cats.length > 0) {
      const { data: insertedLines } = await supabase
        .from('project_cost_lines')
        .select('id, label, budget_category_id, line_price_cents')
        .eq('project_id', projectId)
        .in('budget_category_id', cats);

      for (const r of addRows) {
        const co = coById.get(r.change_order_id);
        if (!co || !r.budget_category_id) continue;
        const matches = (
          (insertedLines ?? []) as Array<{
            id: string;
            label: string;
            budget_category_id: string;
            line_price_cents: number;
          }>
        ).filter(
          (l) =>
            l.budget_category_id === r.budget_category_id &&
            l.label === ((r as { label?: string | null }).label ?? null),
        );
        for (const m of matches) {
          const contrib: AppliedChangeOrderContribution = {
            co_id: co.id,
            co_title: co.title,
            co_short_id: co.short_id,
            applied_at: co.applied_at,
            action: 'add',
            delta_cents: m.line_price_cents,
          };
          const arr = byLineId.get(m.id) ?? [];
          arr.push(contrib);
          byLineId.set(m.id, arr);
        }
      }
    }
  }

  return { byLineId, byCategoryId, appliedOrder, all };
}

export async function getChangeOrderSummaryForJob(jobId: string): Promise<{
  approved_cost_cents: number;
  pending_cost_cents: number;
  approved_timeline_days: number;
  pending_timeline_days: number;
  pending_count: number;
}> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('change_orders')
    .select('status, cost_impact_cents, timeline_impact_days')
    .eq('job_id', jobId)
    .in('status', ['approved', 'pending_approval']);

  if (error) {
    throw new Error(`Failed to get change order summary for job: ${error.message}`);
  }

  let approved_cost_cents = 0;
  let pending_cost_cents = 0;
  let approved_timeline_days = 0;
  let pending_timeline_days = 0;
  let pending_count = 0;

  for (const row of data ?? []) {
    const r = row as { status: string; cost_impact_cents: number; timeline_impact_days: number };
    if (r.status === 'approved') {
      approved_cost_cents += r.cost_impact_cents;
      approved_timeline_days += r.timeline_impact_days;
    } else {
      pending_cost_cents += r.cost_impact_cents;
      pending_timeline_days += r.timeline_impact_days;
      pending_count += 1;
    }
  }

  return {
    approved_cost_cents,
    pending_cost_cents,
    approved_timeline_days,
    pending_timeline_days,
    pending_count,
  };
}
