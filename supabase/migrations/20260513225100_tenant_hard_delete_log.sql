-- Tenant hard-delete audit log.
--
-- The /api/cron/tenant-hard-delete route purges tenants whose 30-day
-- soft-delete window has passed (per tenant_deletion_requests.effective_at).
-- The cascade DELETE on tenants takes audit_log + tenant_deletion_requests
-- with it, so we need a separate ledger that survives the purge to prove
-- the deletion happened (SOC2 / forensics).
--
-- This table is intentionally NOT FK'd to tenants — the tenant row is
-- already gone by the time we'd be querying this. tenant_id is just a UUID
-- column; we record enough context to reconstruct what was purged.

CREATE TABLE IF NOT EXISTS public.tenant_hard_delete_log (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL,
  tenant_name              text,
  deletion_request_id      uuid NOT NULL,
  requested_by_user_id     uuid NOT NULL,
  requested_at             timestamptz NOT NULL,
  effective_at             timestamptz NOT NULL,
  hard_deleted_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_hard_delete_log_deleted_at
  ON public.tenant_hard_delete_log (hard_deleted_at DESC);

ALTER TABLE public.tenant_hard_delete_log ENABLE ROW LEVEL SECURITY;

-- No tenant-side policies. Only the service-role client (cron + platform
-- admin) reads/writes this table. RLS-on with no policies = inaccessible
-- from the anon/authenticated keys.
