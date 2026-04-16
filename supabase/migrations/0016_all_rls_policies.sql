-- 0016_all_rls_policies.sql
-- Enable RLS and install the standard four-policy set (SELECT/INSERT/UPDATE/DELETE)
-- on every tenant-scoped table created in 0005-0015.
--
-- Every policy uses `tenant_id = public.current_tenant_id()` (see §13.1 of
-- the plan). That function reads `tenant_members` with SECURITY DEFINER, so
-- removing a member revokes access on the next query — no JWT-refresh lag.
--
-- `quote_surfaces` is the exception: it has no `tenant_id` column, so the
-- policy joins through `quotes` (see 0008 header for rationale). A FOR ALL
-- policy is used because all four verbs use the same condition and keeping
-- four copies of the subquery bloats the migration with no benefit.
--
-- All policies are granted to the `authenticated` role. The `anon` role
-- falls through to no policy -> deny. Service role bypasses RLS entirely,
-- which is expected for backups, webhooks, and the signup action.

-- === customers ===
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select_customers ON public.customers
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_customers ON public.customers
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_customers ON public.customers
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_customers ON public.customers
    FOR DELETE TO authenticated
    USING (tenant_id = public.current_tenant_id());

-- === service_catalog ===
ALTER TABLE public.service_catalog ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select_service_catalog ON public.service_catalog
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_service_catalog ON public.service_catalog
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_service_catalog ON public.service_catalog
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_service_catalog ON public.service_catalog
    FOR DELETE TO authenticated
    USING (tenant_id = public.current_tenant_id());

-- === quotes ===
ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select_quotes ON public.quotes
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_quotes ON public.quotes
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_quotes ON public.quotes
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_quotes ON public.quotes
    FOR DELETE TO authenticated
    USING (tenant_id = public.current_tenant_id());

-- === quote_surfaces (inherited tenant via quote_id) ===
ALTER TABLE public.quote_surfaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_access_quote_surfaces ON public.quote_surfaces
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.quotes q
            WHERE q.id = quote_surfaces.quote_id
              AND q.tenant_id = public.current_tenant_id()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.quotes q
            WHERE q.id = quote_surfaces.quote_id
              AND q.tenant_id = public.current_tenant_id()
        )
    );

-- === jobs ===
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select_jobs ON public.jobs
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_jobs ON public.jobs
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_jobs ON public.jobs
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_jobs ON public.jobs
    FOR DELETE TO authenticated
    USING (tenant_id = public.current_tenant_id());

-- === photos ===
ALTER TABLE public.photos ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select_photos ON public.photos
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_photos ON public.photos
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_photos ON public.photos
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_photos ON public.photos
    FOR DELETE TO authenticated
    USING (tenant_id = public.current_tenant_id());

-- === invoices ===
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select_invoices ON public.invoices
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_invoices ON public.invoices
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_invoices ON public.invoices
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_invoices ON public.invoices
    FOR DELETE TO authenticated
    USING (tenant_id = public.current_tenant_id());

-- === todos ===
ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select_todos ON public.todos
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_todos ON public.todos
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_todos ON public.todos
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_todos ON public.todos
    FOR DELETE TO authenticated
    USING (tenant_id = public.current_tenant_id());

-- === worklog_entries ===
ALTER TABLE public.worklog_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select_worklog_entries ON public.worklog_entries
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_worklog_entries ON public.worklog_entries
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_worklog_entries ON public.worklog_entries
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_worklog_entries ON public.worklog_entries
    FOR DELETE TO authenticated
    USING (tenant_id = public.current_tenant_id());

-- === audit_log ===
-- Users can read their tenant's audit trail. We allow INSERT from the
-- authenticated role so server actions (running with the user's JWT) can
-- write audit rows. UPDATE/DELETE are not policy-enabled: audit_log is
-- effectively append-only. (Service role can still rewrite it; that's
-- expected for ops.)
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select_audit_log ON public.audit_log
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_audit_log ON public.audit_log
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());

-- === data_exports ===
ALTER TABLE public.data_exports ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select_data_exports ON public.data_exports
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_data_exports ON public.data_exports
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_data_exports ON public.data_exports
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
