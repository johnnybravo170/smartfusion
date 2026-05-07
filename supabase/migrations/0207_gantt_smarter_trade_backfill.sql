-- 0207_gantt_smarter_trade_backfill.sql
-- Improve project_budget_categories.trade_template_id auto-mapping.
--
-- The 0206 migration's exact-name backfill matched ~66% of existing
-- categories. The remaining 34% are GC-custom names like "Plumbing
-- rough + fixtures", "Electrical (heated floor + lighting)", and
-- "Demolition" — recognizable to a human but missed by exact match.
--
-- Two new passes:
--   1. Specific aliases (Demolition → Demo, etc.) — a curated list.
--   2. First-word match — "Plumbing rough + fixtures" → first word
--      "Plumbing" → matches trade "Plumbing". Run AFTER alias pass and
--      AFTER the existing exact pass so more-specific matches win.
--
-- Both passes only touch rows where trade_template_id IS NULL — never
-- overwrite an existing mapping (operator may have manually corrected
-- a row by the time this runs in prod).

-- 1. Curated aliases for common GC name variants.

UPDATE public.project_budget_categories pbc
SET trade_template_id = tr.id
FROM public.trade_templates tr
WHERE pbc.trade_template_id IS NULL
  AND tr.slug = 'demo'
  AND LOWER(TRIM(pbc.name)) IN ('demolition', 'demo work', 'demolition + disposal');

UPDATE public.project_budget_categories pbc
SET trade_template_id = tr.id
FROM public.trade_templates tr
WHERE pbc.trade_template_id IS NULL
  AND tr.slug = 'plumbing_fixtures'
  AND LOWER(TRIM(pbc.name)) IN ('fixtures', 'plumbing fixtures + finish');

UPDATE public.project_budget_categories pbc
SET trade_template_id = tr.id
FROM public.trade_templates tr
WHERE pbc.trade_template_id IS NULL
  AND tr.slug = 'doors_mouldings'
  AND LOWER(TRIM(pbc.name)) IN ('mouldings', 'trim', 'casings', 'baseboards');

UPDATE public.project_budget_categories pbc
SET trade_template_id = tr.id
FROM public.trade_templates tr
WHERE pbc.trade_template_id IS NULL
  AND tr.slug = 'kitchen'
  AND LOWER(TRIM(pbc.name)) IN ('cabinets', 'cabinetry', 'kitchen cabinets', 'vanity');

-- 2. First-word match. Examples this catches:
--   "Plumbing rough + fixtures"       → "Plumbing"
--   "Electrical (heated floor + ...)" → "Electrical"
--   "Framing + drywall + paint"       → "Framing"
--   "Painting interior"               → "Painting"
--
-- Edge cases:
--   - "Plumbing Fixtures" (the budget bucket) is already mapped to the
--     `plumbing_fixtures` trade by the exact-name pass in 0206, so this
--     pass won't re-map it to plain `plumbing`.
--   - Trade names like "Windows & Doors" have a multi-word name; first
--     word "Windows" won't match a trade whose name starts with the
--     SAME multi-word phrase. We accept that miss; operators with
--     "Windows" as a budget line can map manually in v1's edit UI.

UPDATE public.project_budget_categories pbc
SET trade_template_id = tr.id
FROM public.trade_templates tr
WHERE pbc.trade_template_id IS NULL
  AND LOWER(SPLIT_PART(TRIM(pbc.name), ' ', 1)) = LOWER(tr.name);
