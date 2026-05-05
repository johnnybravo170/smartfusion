-- ============================================================
-- Smarter pricing hints for the cost-line form.
--
-- Replaces the existing ilike-exact + category-fallback strategy
-- in getPricingHintsAction with:
--   1. Trigram (pg_trgm) similarity on the label, so "Closet
--      shelving" and "Closets" cluster together instead of
--      requiring an exact match.
--   2. Optional unit filter — drop $X/lot hints when the operator
--      is filling out a $/item field.
--   3. Frequency aggregation — collapse identical (price, unit)
--      groups, surface use_count so the ranker can prefer
--      well-worn prices over one-offs.
--
-- pg_trgm is already enabled by 0112_contacts_fuzzy_name_match.
-- The expression index is on `lower(label)` so case differences
-- in operator-typed labels ("Closets" vs "closets") still hit
-- the index.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_project_cost_lines_label_trgm
  ON public.project_cost_lines
  USING gin (lower(label) gin_trgm_ops);

CREATE OR REPLACE FUNCTION public.find_pricing_hints(
  p_label              text,
  p_unit               text        DEFAULT NULL,
  p_threshold          real        DEFAULT 0.3,
  p_limit              integer     DEFAULT 3,
  p_exclude_project_id uuid        DEFAULT NULL,
  p_since              timestamptz DEFAULT (now() - interval '180 days')
)
RETURNS TABLE (
  unit_price_cents  integer,
  unit              text,
  source_label      text,
  source_project_id uuid,
  last_used_at      timestamptz,
  use_count         integer,
  similarity        real
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH candidates AS (
    SELECT
      cl.unit_price_cents,
      cl.unit,
      cl.label,
      cl.project_id,
      cl.created_at,
      similarity(lower(cl.label), lower(p_label)) AS sim
    FROM public.project_cost_lines cl
    JOIN public.projects p ON p.id = cl.project_id
    WHERE p.tenant_id = public.current_tenant_id()
      AND cl.created_at >= p_since
      AND cl.unit_price_cents > 0
      AND similarity(lower(cl.label), lower(p_label)) >= p_threshold
      AND (p_unit IS NULL OR cl.unit = p_unit)
      AND (p_exclude_project_id IS NULL OR cl.project_id <> p_exclude_project_id)
  ),
  grouped AS (
    SELECT
      c.unit_price_cents,
      c.unit,
      count(*)::integer                                AS use_count,
      max(c.created_at)                                AS last_used_at,
      max(c.sim)                                       AS similarity,
      (array_agg(c.label      ORDER BY c.created_at DESC))[1] AS source_label,
      (array_agg(c.project_id ORDER BY c.created_at DESC))[1] AS source_project_id
    FROM candidates c
    GROUP BY c.unit_price_cents, c.unit
  )
  SELECT
    g.unit_price_cents,
    g.unit,
    g.source_label,
    g.source_project_id,
    g.last_used_at,
    g.use_count,
    g.similarity
  FROM grouped g
  -- Similarity is the primary signal (does this row even match the
  -- typed label?). At a similar match score, frequency wins over
  -- recency: a price you've used 8 times beats one you typed once
  -- last week.
  ORDER BY g.similarity DESC, g.use_count DESC, g.last_used_at DESC
  LIMIT p_limit;
$$;

COMMENT ON FUNCTION public.find_pricing_hints IS
  'Returns frequency-aggregated price suggestions for the cost-line form. Trigram-similar to p_label, optionally unit-matched, ranked by similarity then use_count then recency.';
