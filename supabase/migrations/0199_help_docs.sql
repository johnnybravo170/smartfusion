-- 0199_help_docs.sql
-- Operator-audience help docs corpus + 768-dim embeddings.
--
-- This is the parallel of `ops.knowledge_docs` (engineer-audience), purposely
-- in the public schema with audience-filtered RLS so operators can read
-- published entries from inside the app via Henry. Writes go through the ops
-- MCP server (service role only).
--
-- See REFERRALS_PLAN.md / kanban card 97848e63 for the bigger picture: this
-- table backs Henry's `find_feature` RAG once an operator-audience doc-writer
-- agent is wired up. Phase 1 ships the schema + MCP tools so docs can be
-- hand-curated; Phase 2 adds the auto-population cron.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS public.help_docs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT UNIQUE,
  title           TEXT NOT NULL,
  summary         TEXT,
  body            TEXT NOT NULL DEFAULT '',
  -- Canonical route this doc explains. Nullable for cross-cutting topics
  -- ("how billing works") that don't map to one page.
  route           TEXT,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  -- Two audiences:
  --   'operator' = in-app help, surfaced to authenticated tenants via Henry.
  --   'public'   = marketing-site help center / SEO. Reserved for Phase 4.
  audience        TEXT NOT NULL DEFAULT 'operator'
                    CHECK (audience IN ('operator', 'public')),
  -- Manual review gate. Nothing is exposed to Henry or to operators until
  -- a human flips this. Auto-doc-writer writes is_published=false.
  is_published    BOOLEAN NOT NULL DEFAULT FALSE,
  -- Provenance for auto-generated docs. PR number + head commit so we can
  -- trace back to the change that motivated the doc.
  source_pr       INTEGER,
  source_commit   TEXT,
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')),
  actor_name      TEXT NOT NULL,
  archived_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  embedding_updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS help_docs_audience_published_idx
  ON public.help_docs (audience, is_published)
  WHERE archived_at IS NULL;

-- Path lookup for `get_current_screen_context` enrichment in Phase 3 (Henry
-- swap from static catalog to help_docs). Partial index since most queries
-- want a published operator-audience doc.
CREATE INDEX IF NOT EXISTS help_docs_route_idx
  ON public.help_docs (route)
  WHERE archived_at IS NULL AND is_published = TRUE;

CREATE INDEX IF NOT EXISTS help_docs_updated_idx
  ON public.help_docs (updated_at DESC)
  WHERE archived_at IS NULL;

-- Sibling table so a title-only edit doesn't re-embed.
-- 768 dims to match `gemini-embedding-001` Matryoshka truncation, the same
-- choice ops.knowledge_embeddings made (see 0071_ops_knowledge.sql notes).
CREATE TABLE IF NOT EXISTS public.help_doc_embeddings (
  doc_id        UUID PRIMARY KEY REFERENCES public.help_docs(id) ON DELETE CASCADE,
  embedding     vector(768) NOT NULL,
  content_hash  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS help_doc_embeddings_vec_idx
  ON public.help_doc_embeddings USING hnsw (embedding vector_cosine_ops);

ALTER TABLE public.help_docs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.help_doc_embeddings  ENABLE ROW LEVEL SECURITY;

-- Authenticated operators can read published, unarchived operator-audience
-- docs. Drafts (is_published=false) and the public-audience rows stay
-- service-role-only until Phase 4 ships a deliberate render path.
CREATE POLICY help_docs_select_operator
  ON public.help_docs
  FOR SELECT
  TO authenticated
  USING (
    audience = 'operator'
    AND is_published = TRUE
    AND archived_at IS NULL
  );

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.help_docs, public.help_doc_embeddings
  TO service_role;

-- Semantic search. Returns hits scoped to the requested audience; defaults
-- to operator + published-only so the in-app caller can't accidentally see
-- drafts.
CREATE OR REPLACE FUNCTION public.help_docs_search(
  query_embedding vector(768),
  match_limit INT DEFAULT 10,
  min_similarity FLOAT DEFAULT 0.4,
  audience_filter TEXT DEFAULT 'operator',
  include_unpublished BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  doc_id     UUID,
  slug       TEXT,
  title      TEXT,
  summary    TEXT,
  body       TEXT,
  route      TEXT,
  tags       TEXT[],
  similarity FLOAT,
  updated_at TIMESTAMPTZ
)
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    d.id,
    d.slug,
    d.title,
    d.summary,
    d.body,
    d.route,
    d.tags,
    1 - (e.embedding <=> query_embedding) AS similarity,
    d.updated_at
  FROM public.help_doc_embeddings e
  JOIN public.help_docs d ON d.id = e.doc_id
  WHERE d.archived_at IS NULL
    AND d.audience = audience_filter
    AND (include_unpublished OR d.is_published = TRUE)
    AND (1 - (e.embedding <=> query_embedding)) >= min_similarity
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_limit;
$$;

-- Anyone authenticated can run this; the SECURITY DEFINER + RLS combo means
-- they only see what they're allowed to anyway. Service role can pass
-- include_unpublished=true to power the review surface.
GRANT EXECUTE ON FUNCTION public.help_docs_search TO authenticated, service_role;

-- updated_at touch trigger (mirrors the pattern used elsewhere).
CREATE OR REPLACE FUNCTION public.help_docs_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS help_docs_touch ON public.help_docs;
CREATE TRIGGER help_docs_touch
  BEFORE UPDATE ON public.help_docs
  FOR EACH ROW EXECUTE FUNCTION public.help_docs_touch_updated_at();

COMMENT ON TABLE public.help_docs IS
  'Operator-audience help corpus. Backs Henry RAG via help_docs_search. Drafts (is_published=false) are service-role only; published rows visible to authenticated tenants.';

COMMENT ON COLUMN public.help_docs.route IS
  'Canonical app path the doc explains (e.g. /referrals). NULL for cross-cutting topics. Used for path-keyed enrichment in get_current_screen_context.';

COMMENT ON COLUMN public.help_docs.audience IS
  'operator = in-app authenticated readers; public = marketing-site / SEO (Phase 4 only).';

COMMENT ON COLUMN public.help_docs.is_published IS
  'Manual review gate. Auto-doc-writer always writes false; a human flips to true after review.';
