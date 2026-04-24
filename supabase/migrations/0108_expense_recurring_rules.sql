-- Recurring overhead expenses.
--
-- Shop rent, phone, insurance, software — same amount every month, same
-- vendor + category, same GST portion. Manually logging each is busywork.
--
-- Design: `expense_recurring_rules` stores a template (fields cloned from
-- a source expense the first time it's made recurring), plus a schedule
-- (monthly, day-of-month 1-28 to dodge month-length edge cases). A daily
-- cron materialises a real expense row when the schedule fires. Operator
-- can cancel / archive the rule at any time.
--
-- No draft state for MVP — the cron creates real expenses; operator can
-- delete if wrong. Lower friction than a confirm-each approach, and the
-- template is always created from a known-good source expense so
-- false-positive "this is wrong" cases should be rare.

BEGIN;

CREATE TABLE public.expense_recurring_rules (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  created_by        UUID REFERENCES public.tenant_members(id) ON DELETE SET NULL,
  -- Template fields cloned from the source expense.
  category_id       UUID REFERENCES public.expense_categories(id) ON DELETE SET NULL,
  vendor            TEXT,
  description       TEXT,
  amount_cents      BIGINT NOT NULL CHECK (amount_cents <> 0),
  tax_cents         BIGINT NOT NULL DEFAULT 0,
  -- Schedule.
  frequency         TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('monthly')),
  day_of_month      INT NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
  next_run_at       DATE NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_expense_recurring_rules_tenant
  ON public.expense_recurring_rules(tenant_id)
  WHERE active = TRUE;

CREATE INDEX idx_expense_recurring_rules_due
  ON public.expense_recurring_rules(next_run_at)
  WHERE active = TRUE;

ALTER TABLE public.expense_recurring_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY erp_tenant_select ON public.expense_recurring_rules
  FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id());

CREATE POLICY erp_tenant_insert ON public.expense_recurring_rules
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.current_tenant_id());

CREATE POLICY erp_tenant_update ON public.expense_recurring_rules
  FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

CREATE POLICY erp_tenant_delete ON public.expense_recurring_rules
  FOR DELETE TO authenticated
  USING (tenant_id = public.current_tenant_id());

-- Expenses produced by a rule reference it so we can show "this came from
-- a recurring rule" + link back for edit. Nullable so ad-hoc expenses
-- have no FK overhead.
ALTER TABLE public.expenses
  ADD COLUMN recurring_rule_id UUID REFERENCES public.expense_recurring_rules(id) ON DELETE SET NULL;

CREATE INDEX idx_expenses_recurring_rule ON public.expenses(recurring_rule_id)
  WHERE recurring_rule_id IS NOT NULL;

COMMIT;
