-- 0144_member_reminders.sql
-- Recurring per-member reminders (e.g. "log time + receipts at 5:30pm Mon-Fri").
--
-- One row per (tenant_member, kind). Cron picks up enabled rows whose local
-- time matches now in the tenant's timezone and fires through the chosen
-- channel. Channel enum already includes `push` so swapping the cron over
-- to native push notifications later is a runtime change, not a schema one.

CREATE TABLE IF NOT EXISTS public.member_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  tenant_member_id UUID NOT NULL REFERENCES public.tenant_members (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('daily_logging', 'weekly_review')),
  local_time TEXT NOT NULL CHECK (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  days_of_week SMALLINT[] NOT NULL DEFAULT ARRAY[1,2,3,4,5]::SMALLINT[],
  channel TEXT NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms', 'email', 'push')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT member_reminders_member_kind_unique UNIQUE (tenant_member_id, kind)
);

CREATE INDEX IF NOT EXISTS member_reminders_tenant_id_idx
  ON public.member_reminders (tenant_id);
CREATE INDEX IF NOT EXISTS member_reminders_enabled_idx
  ON public.member_reminders (enabled) WHERE enabled = true;

ALTER TABLE public.member_reminders ENABLE ROW LEVEL SECURITY;

-- SELECT: members can see reminders inside their tenant. Cron uses service
-- role so it bypasses this anyway.
CREATE POLICY member_reminders_select_own
  ON public.member_reminders
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.current_tenant_id());

-- INSERT/UPDATE/DELETE: a member can only manage their own reminders, scoped
-- to their active tenant. The tenant_member_id check below enforces both
-- "in my tenant" (via current_tenant_id) and "for me" (via auth.uid()).
CREATE POLICY member_reminders_insert_own
  ON public.member_reminders
  FOR INSERT
  TO authenticated
  WITH CHECK (
    tenant_id = public.current_tenant_id()
    AND tenant_member_id IN (
      SELECT id FROM public.tenant_members
      WHERE user_id = auth.uid() AND tenant_id = public.current_tenant_id()
    )
  );

CREATE POLICY member_reminders_update_own
  ON public.member_reminders
  FOR UPDATE
  TO authenticated
  USING (
    tenant_id = public.current_tenant_id()
    AND tenant_member_id IN (
      SELECT id FROM public.tenant_members
      WHERE user_id = auth.uid() AND tenant_id = public.current_tenant_id()
    )
  )
  WITH CHECK (tenant_id = public.current_tenant_id());

CREATE POLICY member_reminders_delete_own
  ON public.member_reminders
  FOR DELETE
  TO authenticated
  USING (
    tenant_id = public.current_tenant_id()
    AND tenant_member_id IN (
      SELECT id FROM public.tenant_members
      WHERE user_id = auth.uid() AND tenant_id = public.current_tenant_id()
    )
  );

COMMENT ON TABLE public.member_reminders IS
  'Recurring per-member reminders (daily logging, weekly review). Cron sends via SMS today, push later when the native app ships.';
