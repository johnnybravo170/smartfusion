-- 0194_payment_sources.sql
--
-- Per-card / per-funding-source tracking for expenses. The user's real
-- problem: I paid for things on my personal debit card, and I want
-- those rows flagged so my bookkeeper reimburses me from petty cash at
-- the QB level. Today, expenses has no payment-method or funding-
-- source field at all — every receipt is silently treated as "business
-- account".
--
-- Design (per the conversation that produced this migration):
--   - One `payment_sources` row per registered card (or non-card
--     instrument: cash / e-transfer / cheque / "Personal — reimburse
--     me"). Tenant-scoped, editable, archivable.
--   - The user labels each card once ("JB Debit", "TD VISA"). Last-4
--     extracted from receipts via OCR keys auto-resolution on future
--     imports.
--   - `paid_by` is the load-bearing field for QB sync — 'business'
--     posts against bank/CC, 'personal_reimbursable' books to Owner
--     Equity / Due-to-Owner, 'petty_cash' books to Petty Cash. Sync
--     itself is deferred (QBO_PLAN expense epic).
--   - `expenses.payment_source_id` FK + `expenses.card_last4` snapshot
--     for audit. Snapshot stays even if the source is renamed/archived
--     so historical receipts are never ambiguous.
--
-- See PATTERNS.md §11 — this table needs a cross-tenant RLS test entry
-- in the same PR.

BEGIN;

-- ============================================================
-- 1. payment_sources table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.payment_sources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,

  -- Operator-friendly label. "JB Debit", "TD VISA", "Petty cash".
  label         TEXT NOT NULL CHECK (length(trim(label)) > 0),

  -- Last 4 of the card number, when known. Cash / e-transfer / cheque
  -- have no last4. The unique-on-last4 partial index below means the
  -- same card can't be registered twice per tenant.
  last4         TEXT CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$'),

  -- Card network if visible on the receipt. Pure UX; optional.
  network       TEXT CHECK (network IS NULL OR network IN
                  ('visa','mastercard','amex','interac','discover','other')),

  -- Instrument kind. Drives the picker icon and is the closest analog
  -- to a payment-method enum we already have on invoices (0035).
  kind          TEXT NOT NULL DEFAULT 'other'
                  CHECK (kind IN ('debit','credit','cash','etransfer','cheque','other')),

  -- Funding source. The QB-sync-relevant field.
  --   'business'              — business bank/CC. Default behavior.
  --   'personal_reimbursable' — owner paid out of pocket; needs reimbursement.
  --   'petty_cash'            — drawn from petty cash float.
  paid_by       TEXT NOT NULL DEFAULT 'business'
                  CHECK (paid_by IN ('business','personal_reimbursable','petty_cash')),

  -- Optional default chart-of-accounts code per source. When set,
  -- overrides the category's account_code at QB sync time. Lets "JB
  -- Debit" map straight to the right Owner Equity sub-account without
  -- having to denormalize that into every category.
  default_account_code TEXT,

  -- Marks the tenant's fallback source — used when OCR finds no last4
  -- and the operator hasn't picked something else. Exactly one default
  -- per tenant is enforced by a partial unique index below.
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,

  archived_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One card (by last4) registered exactly once per tenant. Cash /
-- e-transfer / cheque entries have last4 = NULL and aren't constrained.
CREATE UNIQUE INDEX IF NOT EXISTS payment_sources_tenant_last4_unique
  ON public.payment_sources (tenant_id, last4)
  WHERE last4 IS NOT NULL AND archived_at IS NULL;

-- Labels are case-insensitive unique within active rows so the picker
-- doesn't show duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS payment_sources_tenant_label_unique
  ON public.payment_sources (tenant_id, lower(label))
  WHERE archived_at IS NULL;

-- Exactly one default source per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS payment_sources_tenant_default_unique
  ON public.payment_sources (tenant_id)
  WHERE is_default = TRUE AND archived_at IS NULL;

-- Tenant-scoped listing index (the picker query).
CREATE INDEX IF NOT EXISTS idx_payment_sources_tenant
  ON public.payment_sources (tenant_id)
  WHERE archived_at IS NULL;

-- ============================================================
-- 2. RLS — same shape as expense_categories.
-- ============================================================
ALTER TABLE public.payment_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY payment_sources_tenant_select ON public.payment_sources
  FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id());

CREATE POLICY payment_sources_tenant_insert ON public.payment_sources
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.current_tenant_id());

CREATE POLICY payment_sources_tenant_update ON public.payment_sources
  FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

CREATE POLICY payment_sources_tenant_delete ON public.payment_sources
  FOR DELETE TO authenticated
  USING (tenant_id = public.current_tenant_id());

-- ============================================================
-- 3. Columns on expenses
-- ============================================================
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS payment_source_id UUID
    REFERENCES public.payment_sources (id) ON DELETE SET NULL,
  -- Snapshot of the last 4 at the time of entry. Survives source
  -- rename/archive so historical rows stay unambiguous.
  ADD COLUMN IF NOT EXISTS card_last4 TEXT
    CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$');

CREATE INDEX IF NOT EXISTS idx_expenses_payment_source
  ON public.expenses (payment_source_id)
  WHERE payment_source_id IS NOT NULL;

-- ============================================================
-- 4. Seed defaults for new tenants (RPC) + backfill.
--
-- Seeds three universal sources so the picker is never empty:
--   - "Business"               (default, paid_by=business)
--   - "Personal (reimburse me)" (paid_by=personal_reimbursable)
--   - "Petty cash"             (paid_by=petty_cash)
-- Card-based sources ("JB Debit") get added later via the labeling
-- flow when an unrecognized last4 shows up on a receipt.
-- ============================================================
CREATE OR REPLACE FUNCTION public.seed_default_payment_sources(p_tenant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.payment_sources (tenant_id, label, kind, paid_by, is_default)
  VALUES (p_tenant_id, 'Business', 'other', 'business', TRUE)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.payment_sources (tenant_id, label, kind, paid_by, is_default)
  VALUES (p_tenant_id, 'Personal (reimburse me)', 'other', 'personal_reimbursable', FALSE)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.payment_sources (tenant_id, label, kind, paid_by, is_default)
  VALUES (p_tenant_id, 'Petty cash', 'cash', 'petty_cash', FALSE)
  ON CONFLICT DO NOTHING;
END;
$$;

GRANT EXECUTE ON FUNCTION public.seed_default_payment_sources(UUID)
  TO authenticated, service_role;

-- Backfill every tenant currently sitting on zero sources.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT t.id
    FROM public.tenants t
    WHERE NOT EXISTS (
      SELECT 1 FROM public.payment_sources ps
      WHERE ps.tenant_id = t.id
    )
  LOOP
    PERFORM public.seed_default_payment_sources(r.id);
  END LOOP;
END;
$$;

COMMENT ON TABLE public.payment_sources IS
  'Per-tenant catalog of payment instruments (cards) and funding sources (cash, personal-reimbursable, petty cash). Receipts auto-resolve to a source when OCR pulls a last4 that matches a registered card. paid_by is the QB-sync-relevant field — drives whether the expense posts against a bank/CC account, Owner Equity, or Petty Cash.';
COMMENT ON COLUMN public.expenses.payment_source_id IS
  'Which payment_sources row funded this expense. NULL on legacy rows (pre-migration); new rows pick the tenant default when nothing else resolves.';
COMMENT ON COLUMN public.expenses.card_last4 IS
  'Snapshot of the card''s last 4 at entry time. Survives renaming or archiving the linked payment_source so historical rows stay readable.';

COMMIT;
