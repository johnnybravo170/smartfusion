-- 0171_bank_tx_match_candidates.sql
-- BR-5 (payment auto-detect): the matcher produces a ranked list of up to
-- 3 candidates per bank_transaction. We store them denormalized on the
-- transaction row so the BR-7 review queue renders without re-running
-- the scorer on every page load.
--
-- Shape of `match_candidates`:
--   [
--     {
--       "kind": "invoice" | "expense" | "bill",
--       "id": "<uuid>",
--       "score": 0..100,
--       "confidence": "high" | "medium" | "low",
--       "amount_cents": -1234,
--       "tx_date": "2026-03-15",      -- invoice.sent_at | expense.expense_date | bill.bill_date
--       "label": "Acme Plumbing"      -- vendor or customer name (cached for display)
--     }, ...
--   ]
--
-- `match_score` mirrors candidates[0].score so review queue ordering can
-- be done at the SQL layer.

ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS match_candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS match_score INT;

-- Review queue ordering: highest-scored suggestions first within a tenant.
CREATE INDEX IF NOT EXISTS idx_bank_transactions_tenant_status_score
  ON public.bank_transactions (tenant_id, match_status, match_score DESC NULLS LAST);

COMMENT ON COLUMN public.bank_transactions.match_candidates IS
  'Top-3 ranked candidates from BR-5 auto-match. Denormalized for review queue display; re-run on confirm to validate freshness.';
