-- Fix silent RLS block on public_page_views and project_events.
--
-- Root cause: migration 0050 created both tables and (via Supabase's
-- dashboard default or a later migration) RLS was enabled, but no
-- policies were ever added. Authenticated reads returned zero rows and
-- authenticated inserts silently failed. Service-role writes (from the
-- public approve page, chat tools, etc.) worked because they bypass RLS,
-- so rows accumulated in the DB — but every operator dashboard read
-- came back empty, and any authenticated-client insert (e.g. the
-- invoice_created event in server/actions/invoices.ts) never landed.
--
-- Symptom: "JVD sent an estimate, customer confirmed they opened it,
-- but Henry shows 'not opened yet' forever."
--
-- Fix: tenant-scoped SELECT + INSERT policies mirroring the pattern
-- used on photos (migration 0041) and worker_invoices (0057).
-- Service-role continues to bypass RLS as before.

-- ---------------------------------------------------------------------------
-- public_page_views
-- ---------------------------------------------------------------------------

CREATE POLICY "public_page_views_select_own_tenant"
  ON public.public_page_views
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.current_tenant_id());

CREATE POLICY "public_page_views_insert_own_tenant"
  ON public.public_page_views
  FOR INSERT
  TO authenticated
  WITH CHECK (tenant_id = public.current_tenant_id());

-- ---------------------------------------------------------------------------
-- project_events
-- ---------------------------------------------------------------------------

CREATE POLICY "project_events_select_own_tenant"
  ON public.project_events
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.current_tenant_id());

CREATE POLICY "project_events_insert_own_tenant"
  ON public.project_events
  FOR INSERT
  TO authenticated
  WITH CHECK (tenant_id = public.current_tenant_id());
