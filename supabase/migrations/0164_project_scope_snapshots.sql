-- 0164_project_scope_snapshots.sql
-- Snapshots of a project's scope (cost lines + budget categories + total)
-- captured at every "customer-signed" moment: initial estimate approval +
-- each CO `applied_at`. Forms the baseline against which working state is
-- diffed for the unsent-changes chip + diff review screen.
--
-- See decision 6790ef2b — supersedes the warn-then-allow-at-edit-time
-- model with a diff-tracked + intentional-send approach. The snapshot is
-- the load-bearing primitive for the new flow.
--
-- Existing projects (already approved before this migration) won't have
-- snapshots until their NEXT signed event. The diff query handles the
-- absent-snapshot case gracefully (no chip shown).

CREATE TABLE IF NOT EXISTS public.project_scope_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,

  -- Monotonic per project: 1 for the original estimate, 2+ for each
  -- applied CO. Operator-facing version label ("v1", "v2 (CO #1)", etc.)
  -- is computed from this + change_order metadata in the queries layer.
  version_number INTEGER NOT NULL CHECK (version_number >= 1),

  -- Optional human-friendly label, e.g. "Original estimate" or
  -- "CO #1 — Kitchen scope". Kept denormalised so the snapshot is
  -- self-contained for the read path.
  label TEXT,

  -- Pointer back to the change_order that created this snapshot, if
  -- any. NULL for the v1 estimate-approval snapshot.
  change_order_id UUID REFERENCES public.change_orders (id) ON DELETE SET NULL,

  -- Frozen state at signing time. JSONB so the snapshot survives
  -- downstream renames / restructures. Schema is documented in the
  -- snapshotProjectScope() helper.
  cost_lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  budget_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_cents BIGINT NOT NULL DEFAULT 0,

  -- The customer-facing event timestamp. signed_at = when the customer
  -- accepted (or operator manually marked accepted on their behalf).
  signed_at TIMESTAMPTZ NOT NULL,
  signed_by_name TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pss_unique_version UNIQUE (project_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_pss_project_version
  ON public.project_scope_snapshots (project_id, version_number DESC);

CREATE INDEX IF NOT EXISTS idx_pss_tenant_signed_at
  ON public.project_scope_snapshots (tenant_id, signed_at DESC);

-- RLS — tenant-scoped CRUD. Owners + admins + workers all read; only
-- system code (server actions) writes via the admin client. RLS still
-- protects against cross-tenant leaks.
ALTER TABLE public.project_scope_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_select_pss ON public.project_scope_snapshots
  FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());

CREATE POLICY tenant_insert_pss ON public.project_scope_snapshots
  FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());

-- No update / delete policies: snapshots are immutable. They represent
-- what was signed at a moment; mutating them would corrupt the audit
-- trail. Cleanup happens via CASCADE on project / tenant delete.

COMMENT ON TABLE public.project_scope_snapshots IS
  'Immutable snapshot of a project''s scope (cost_lines + budget_categories + total) at every customer-signed event (initial estimate + each applied CO). Baseline for the unsent-changes diff. See decision 6790ef2b.';
