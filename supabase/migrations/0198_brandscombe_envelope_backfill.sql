-- One-off backfill for the Brandscombe project (Connect Contracting):
-- align project_budget_categories.estimate_cents with the actual sum of
-- project_cost_lines.line_price_cents per category. Imports + manual
-- edits had left the per-category envelope stale, which caused the
-- portal financials to display drastically understated numbers and
-- miscalibrated overrun warnings on the operator side.
--
-- Idempotent: only updates rows where the current estimate disagrees
-- with the cost-line sum, so re-runs are safe no-ops.

WITH sums AS (
  SELECT bc.id AS category_id,
         COALESCE(SUM(cl.line_price_cents), 0)::bigint AS lines_total
  FROM project_budget_categories bc
  LEFT JOIN project_cost_lines cl ON cl.budget_category_id = bc.id
  WHERE bc.project_id = '1334d3c8-32db-4422-a842-8d2e729baa24'
  GROUP BY bc.id
)
UPDATE project_budget_categories bc
SET estimate_cents = sums.lines_total,
    updated_at = now()
FROM sums
WHERE bc.id = sums.category_id
  AND bc.estimate_cents IS DISTINCT FROM sums.lines_total;
