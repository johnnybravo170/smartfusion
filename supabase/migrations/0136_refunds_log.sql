-- 0136_refunds_log.sql
-- Audit log for every refund issued from the platform Stripe account.
-- Self-serve cancel flow writes a row per cancellation (amount=0 for trial
-- cancels, prorated cents otherwise). Future manual / goodwill refunds use
-- the same table — `reason` distinguishes the source.
--
-- Writes happen via server actions using the service-role client; no INSERT
-- policy is defined on purpose (RLS denies by default). SELECT is scoped to
-- tenant members so an owner can see their own refund history later.

CREATE TABLE IF NOT EXISTS public.refunds_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  stripe_subscription_id  text,
  stripe_charge_id        text,
  stripe_refund_id        text,
  amount_cents    bigint NOT NULL,
  currency        text NOT NULL DEFAULT 'cad',
  reason          text NOT NULL,                    -- 'user_cancel' | 'manual' | 'goodwill'
  notes           text,
  refunded_at     timestamptz NOT NULL DEFAULT now(),
  refunded_by     text,                              -- user_id or 'jonathan' or 'system'
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS refunds_log_tenant_id_idx ON public.refunds_log (tenant_id);
CREATE INDEX IF NOT EXISTS refunds_log_refunded_at_idx ON public.refunds_log (refunded_at DESC);

ALTER TABLE public.refunds_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY refunds_log_owner_select ON public.refunds_log
  FOR SELECT USING (
    tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = auth.uid())
  );
-- write-only via server actions / service role; no policy for INSERT/UPDATE/DELETE

COMMENT ON TABLE public.refunds_log IS
  'Audit log for refunds issued from the platform Stripe account. Self-serve cancel writes one row per cancellation (amount=0 for trial).';
