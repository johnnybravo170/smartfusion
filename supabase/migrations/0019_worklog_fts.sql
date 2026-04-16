-- 0019_worklog_fts.sql
-- Full-text search on `worklog_entries` via a generated tsvector column
-- + GIN index.
--
-- `search_vector` is a generated tsvector column (English configuration) so
-- the index stays in sync with the row. Weight 'A' on the title, 'B' on the
-- body — a query matching the title ranks higher than one matching body text.
-- Search uses Postgres `websearch_to_tsquery` via the Supabase `textSearch()`
-- client helper.
--
-- The `(tenant_id, created_at DESC)` B-tree index that supports the
-- reverse-chrono feed is already installed by migration 0017 (see
-- `worklog_entries_tenant_created_idx`); we don't re-create it here to keep
-- one canonical definition per index.
--
-- Spec: PHASE_1_PLAN.md §8 Track E.

ALTER TABLE public.worklog_entries
    ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(body, '')), 'B')
    ) STORED;

CREATE INDEX IF NOT EXISTS worklog_entries_search_idx
    ON public.worklog_entries USING gin (search_vector);
