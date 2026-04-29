-- Sub quotes — quotes received from subcontractors / suppliers, allocated
-- to one or more project_cost_buckets. Forms the "committed" leg of
-- cost control (distinct from estimates and from bills/actuals).
--
-- Spec: SUB_QUOTES_PLAN.md. Phase 1 (this migration) lays the data
-- foundation + RLS. Server-action invariant: sum of allocations must
-- equal total_cents before a quote can be `accepted`.

-- ---------------------------------------------------------------------------
-- project_sub_quotes
-- ---------------------------------------------------------------------------

CREATE TABLE public.project_sub_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  vendor_name text NOT NULL,
  vendor_email text,
  vendor_phone text,
  total_cents bigint NOT NULL CHECK (total_cents >= 0),
  scope_description text,
  notes text,
  status text NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'accepted', 'rejected', 'expired', 'superseded')),
  superseded_by_id uuid REFERENCES public.project_sub_quotes(id) ON DELETE SET NULL,
  quote_date date,
  valid_until date,
  received_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'upload', 'email')),
  attachment_storage_path text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sub_quotes_project ON public.project_sub_quotes(project_id, status);
CREATE INDEX idx_sub_quotes_tenant ON public.project_sub_quotes(tenant_id);

ALTER TABLE public.project_sub_quotes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sub_quotes_select_own_tenant"
  ON public.project_sub_quotes
  FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id());

CREATE POLICY "sub_quotes_insert_own_tenant"
  ON public.project_sub_quotes
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.current_tenant_id());

CREATE POLICY "sub_quotes_update_own_tenant"
  ON public.project_sub_quotes
  FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

CREATE POLICY "sub_quotes_delete_own_tenant"
  ON public.project_sub_quotes
  FOR DELETE TO authenticated
  USING (tenant_id = public.current_tenant_id());

-- ---------------------------------------------------------------------------
-- project_sub_quote_allocations
-- ---------------------------------------------------------------------------

CREATE TABLE public.project_sub_quote_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_quote_id uuid NOT NULL REFERENCES public.project_sub_quotes(id) ON DELETE CASCADE,
  bucket_id uuid NOT NULL REFERENCES public.project_cost_buckets(id) ON DELETE CASCADE,
  allocated_cents bigint NOT NULL CHECK (allocated_cents >= 0),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sub_quote_id, bucket_id)
);

CREATE INDEX idx_sub_quote_allocations_quote ON public.project_sub_quote_allocations(sub_quote_id);
CREATE INDEX idx_sub_quote_allocations_bucket ON public.project_sub_quote_allocations(bucket_id);

ALTER TABLE public.project_sub_quote_allocations ENABLE ROW LEVEL SECURITY;

-- Allocations have no tenant_id of their own; they inherit tenancy from
-- the parent sub_quote. Policies check the parent's tenant_id.
CREATE POLICY "sub_quote_allocations_select_own_tenant"
  ON public.project_sub_quote_allocations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.project_sub_quotes sq
      WHERE sq.id = project_sub_quote_allocations.sub_quote_id
        AND sq.tenant_id = public.current_tenant_id()
    )
  );

CREATE POLICY "sub_quote_allocations_insert_own_tenant"
  ON public.project_sub_quote_allocations
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.project_sub_quotes sq
      WHERE sq.id = project_sub_quote_allocations.sub_quote_id
        AND sq.tenant_id = public.current_tenant_id()
    )
  );

CREATE POLICY "sub_quote_allocations_update_own_tenant"
  ON public.project_sub_quote_allocations
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.project_sub_quotes sq
      WHERE sq.id = project_sub_quote_allocations.sub_quote_id
        AND sq.tenant_id = public.current_tenant_id()
    )
  );

CREATE POLICY "sub_quote_allocations_delete_own_tenant"
  ON public.project_sub_quote_allocations
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.project_sub_quotes sq
      WHERE sq.id = project_sub_quote_allocations.sub_quote_id
        AND sq.tenant_id = public.current_tenant_id()
    )
  );

-- ---------------------------------------------------------------------------
-- Storage bucket for sub quote attachments
-- ---------------------------------------------------------------------------
--
-- Attachment paths use the same private pattern as receipts:
-- `sub-quotes/{tenant_id}/{sub_quote_id}.{ext}`. Storage policies mirror
-- the receipts bucket. The bucket is created idempotently so re-runs
-- don't error.

INSERT INTO storage.buckets (id, name, public)
VALUES ('sub-quotes', 'sub-quotes', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "sub_quotes_bucket_select_own_tenant"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'sub-quotes'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

CREATE POLICY "sub_quotes_bucket_insert_own_tenant"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'sub-quotes'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

CREATE POLICY "sub_quotes_bucket_delete_own_tenant"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'sub-quotes'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );
