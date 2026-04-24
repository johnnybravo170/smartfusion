-- ============================================================
-- Estimate boilerplate snippet library + per-project terms text.
--
-- Each tenant keeps a short library of reusable paragraphs
-- (price-includes, exclusions, change rate, deposit terms, etc).
-- On the project estimate tab the operator clicks chips to insert
-- snippet bodies into `projects.terms_text`, a freely-editable
-- textarea that renders on the customer-facing estimate below the
-- total.
--
-- The library is tenant-scoped; snippets flagged is_default auto-
-- insert on first terms edit. New tenant signups get a standard
-- three-snippet GC starter library seeded by the trigger below.
-- ============================================================

-- 1. Per-project terms text (freely edited; snippets just populate it).
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS terms_text TEXT;

COMMENT ON COLUMN public.projects.terms_text IS
  'Free-form terms / notes rendered at the bottom of the customer-facing estimate. Populated from estimate_snippets via the chips UI, freely editable afterwards.';

-- 2. Snippet library.
CREATE TABLE IF NOT EXISTS public.estimate_snippets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  body           TEXT NOT NULL,
  is_default     BOOLEAN NOT NULL DEFAULT false,
  display_order  INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_estimate_snippets_tenant_order
  ON public.estimate_snippets(tenant_id, display_order);

ALTER TABLE public.estimate_snippets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "estimate_snippets_select_own_tenant" ON public.estimate_snippets;
CREATE POLICY "estimate_snippets_select_own_tenant"
  ON public.estimate_snippets
  FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS "estimate_snippets_insert_own_tenant" ON public.estimate_snippets;
CREATE POLICY "estimate_snippets_insert_own_tenant"
  ON public.estimate_snippets
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS "estimate_snippets_update_own_tenant" ON public.estimate_snippets;
CREATE POLICY "estimate_snippets_update_own_tenant"
  ON public.estimate_snippets
  FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS "estimate_snippets_delete_own_tenant" ON public.estimate_snippets;
CREATE POLICY "estimate_snippets_delete_own_tenant"
  ON public.estimate_snippets
  FOR DELETE TO authenticated
  USING (tenant_id = public.current_tenant_id());

-- 3. Seed helper. Idempotent — skips tenants that already have snippets so
--    re-running the migration or signing up via an existing tenant id
--    doesn't create duplicates.
CREATE OR REPLACE FUNCTION public.seed_default_estimate_snippets(p_tenant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.estimate_snippets WHERE tenant_id = p_tenant_id) THEN
    RETURN;
  END IF;

  INSERT INTO public.estimate_snippets (tenant_id, label, body, is_default, display_order)
  VALUES
    (
      p_tenant_id,
      'Price includes',
      'Everything necessary for completion of specified renovation and remodeling including fasteners, adhesives, refuse disposal, etc.',
      true,
      10
    ),
    (
      p_tenant_id,
      'Price does not include + change rate',
      'Unexpected and unknowable changes, additions, or problems pertaining to the dwelling prior to dismantling such as rot, previous construction deficiencies, necessary mechanical upgrades and/or structural failures. Any labour and/or materials associated with the preceding will be charged to the homeowner at the cost of materials plus $70 per hour for each hour of extra labour.',
      true,
      20
    ),
    (
      p_tenant_id,
      'Acceptance terms',
      'All accepted estimates are subject to a signed contract and 50% deposit.',
      true,
      30
    );
END;
$$;

COMMENT ON FUNCTION public.seed_default_estimate_snippets IS
  'Seed the three GC-standard estimate snippets for a tenant. Idempotent — no-op when the tenant already has any snippet.';

-- 4. Backfill every existing tenant.
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT id FROM public.tenants LOOP
    PERFORM public.seed_default_estimate_snippets(t.id);
  END LOOP;
END $$;

-- 5. Trigger on tenant INSERT so new signups auto-seed.
CREATE OR REPLACE FUNCTION public.seed_default_estimate_snippets_on_tenant_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.seed_default_estimate_snippets(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_default_estimate_snippets ON public.tenants;
CREATE TRIGGER trg_seed_default_estimate_snippets
  AFTER INSERT ON public.tenants
  FOR EACH ROW
  EXECUTE FUNCTION public.seed_default_estimate_snippets_on_tenant_insert();
