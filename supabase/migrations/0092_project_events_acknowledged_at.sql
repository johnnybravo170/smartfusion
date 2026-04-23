-- Operator notifications one-off: let the dashboard render a dismissible
-- "🎉 Customer just opened your estimate" card the first time a customer
-- views an estimate. Dismissed state lives on the event itself.
--
-- Backfill existing estimate_viewed rows as already acknowledged so the
-- first deploy doesn't surface stale "just opened" cards for events that
-- happened before the feature existed.

ALTER TABLE public.project_events
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;

UPDATE public.project_events
SET acknowledged_at = now()
WHERE kind = 'estimate_viewed' AND acknowledged_at IS NULL;

-- Index for the dashboard query (tenant + unacknowledged + kind-filtered).
CREATE INDEX IF NOT EXISTS idx_project_events_tenant_kind_unacked
  ON public.project_events (tenant_id, kind, occurred_at DESC)
  WHERE acknowledged_at IS NULL;

-- Allow authenticated users to UPDATE their own tenant's events so the
-- dismiss button can mark acknowledged_at. INSERT + SELECT policies were
-- added in migration 0091; this adds the missing UPDATE.
CREATE POLICY "project_events_update_own_tenant"
  ON public.project_events
  FOR UPDATE
  TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
