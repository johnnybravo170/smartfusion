-- 0149_change_order_lines
--
-- Line-level diff schema for change orders. Each row represents a
-- single edit against the project's cost lines: add / remove / modify.
-- Sum of (line_price after - line_price before) across rows = the CO's
-- cost_impact_cents.
--
-- Phase 1 (this migration + first form pass): persist diffs only. The
-- diff is NOT applied to project_cost_lines on approval yet — that's a
-- later phase. Rows here are a staged audit trail of "what would have
-- happened if accepted."
--
-- change_orders.flow_version distinguishes legacy COs (the cost_breakdown
-- model from 0148, flow_version=1) from new line-diff COs (flow_version=2).
-- Defaulting existing rows to 1 keeps every prior CO valid.

BEGIN;

ALTER TABLE public.change_orders
  ADD COLUMN flow_version SMALLINT NOT NULL DEFAULT 1
    CHECK (flow_version IN (1, 2));

COMMENT ON COLUMN public.change_orders.flow_version IS
  '1 = legacy cost_breakdown attribution. 2 = line-level diff via change_order_lines.';

CREATE TABLE public.change_order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  change_order_id UUID NOT NULL REFERENCES public.change_orders(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

  -- 'add' = new line, 'modify' = edit qty/price/label on existing,
  -- 'remove' = strike out an existing line
  action TEXT NOT NULL CHECK (action IN ('add', 'modify', 'remove')),

  -- For 'modify' and 'remove' this points at the existing line. For 'add'
  -- it's NULL. We don't FK to project_cost_lines because we want the
  -- original_line snapshot to survive a direct delete of the underlying
  -- cost line — the audit trail matters even after the live row is gone.
  original_line_id UUID,

  -- New / modified state (used for 'add' and 'modify'):
  budget_category_id UUID REFERENCES public.project_budget_categories(id) ON DELETE SET NULL,
  category TEXT CHECK (category IN ('material','labour','sub','equipment','overhead')),
  label TEXT,
  notes TEXT,
  qty NUMERIC(12,2),
  unit TEXT,
  unit_cost_cents INTEGER,
  unit_price_cents INTEGER,
  line_cost_cents INTEGER,
  line_price_cents INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,

  -- Snapshot of the existing line BEFORE the change (for 'modify' and
  -- 'remove'). Stored as JSON so the audit trail survives even if the
  -- live cost line is later deleted or renamed. Null for 'add'.
  before_snapshot JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_change_order_lines_co
  ON public.change_order_lines (change_order_id);
CREATE INDEX idx_change_order_lines_tenant
  ON public.change_order_lines (tenant_id);
CREATE INDEX idx_change_order_lines_original
  ON public.change_order_lines (original_line_id)
  WHERE original_line_id IS NOT NULL;

ALTER TABLE public.change_order_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_select_change_order_lines ON public.change_order_lines
  FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_change_order_lines ON public.change_order_lines
  FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_change_order_lines ON public.change_order_lines
  FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_change_order_lines ON public.change_order_lines
  FOR DELETE TO authenticated USING (tenant_id = public.current_tenant_id());

-- Anonymous read by approval_code path (mirrors change_orders policy)
-- so the customer-facing approval page can render the diff.
CREATE POLICY anon_select_change_order_lines_by_co ON public.change_order_lines
  FOR SELECT TO anon
  USING (
    change_order_id IN (
      SELECT id FROM public.change_orders WHERE approval_code IS NOT NULL
    )
  );

COMMIT;
