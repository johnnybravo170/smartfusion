-- Tenant deletion requests (PIPEDA / GDPR right to erasure).
--
-- Flow:
--   1. Owner visits /settings/account/delete, types business name to confirm,
--      passes MFA → row inserted here with effective_at = now() + 30 days,
--      tenants.deleted_at set to now(). Dashboard layout immediately gates
--      access to a "deletion pending" landing page.
--   2. Within the 30-day window the owner can abort (clears tenants.deleted_at,
--      sets aborted_at on the request row). The audit log records both events.
--   3. After 30 days a separate cron job (deferred — manual platform-admin
--      hard-delete for now) will purge the rows the FK cascades reach.
--
-- The table is append-only at the row level — abort doesn't delete the row,
-- it sets aborted_at. We want the trail.

CREATE TABLE IF NOT EXISTS public.tenant_deletion_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  requested_by_user_id  uuid NOT NULL,
  reason                text,
  requested_at          timestamptz NOT NULL DEFAULT now(),
  effective_at          timestamptz NOT NULL,
  aborted_at            timestamptz,
  aborted_by_user_id    uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_deletion_requests_active
  ON public.tenant_deletion_requests (tenant_id)
  WHERE aborted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tenant_deletion_requests_effective
  ON public.tenant_deletion_requests (effective_at)
  WHERE aborted_at IS NULL;

ALTER TABLE public.tenant_deletion_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY tdr_tenant_select ON public.tenant_deletion_requests
  FOR SELECT TO authenticated
  USING (tenant_id IN (
    SELECT tm.tenant_id FROM public.tenant_members tm WHERE tm.user_id = auth.uid()
  ));
