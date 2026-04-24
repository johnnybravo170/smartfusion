-- ============================================================
-- Project document type — estimate (ballpark, non-binding) vs
-- quote (fixed, binding unless scope changes). Affects the
-- heading on the customer-facing page and the "is this legally
-- a fixed price?" vibe; everything else stays the same.
--
-- Options 2 (simplified build flow for quotes) and 3 (separate
-- /projects/new?as=quote surface) are deferred — filed as
-- kanban cards.
-- ============================================================

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS document_type TEXT NOT NULL DEFAULT 'estimate';

ALTER TABLE public.projects
  DROP CONSTRAINT IF EXISTS projects_document_type_check;
ALTER TABLE public.projects
  ADD CONSTRAINT projects_document_type_check
    CHECK (document_type IN ('estimate', 'quote'));

COMMENT ON COLUMN public.projects.document_type IS
  'estimate = best-guess ballpark (default). quote = fixed-price, binding. Affects the heading on the customer-facing page.';
