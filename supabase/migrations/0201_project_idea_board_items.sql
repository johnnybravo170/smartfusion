-- 0201_project_idea_board_items.sql
-- Phase 1 of CUSTOMER_IDEA_BOARD_PLAN.md.
--
-- Customer-driven inspiration scratchpad. Customer uploads images, pastes
-- URLs (Pinterest/vendor sites), and writes free-text notes from the
-- public portal. Operator passively browses on the project Selections
-- tab; an unread badge on the tab pill is the only cue. No external
-- notifications fire — the customer should feel free to dump everything.
--
-- Operator-side promote-to-selection lives in Phase 2 (additive: stamps
-- promoted_to_selection_id + promoted_at; original row stays).
--
-- Storage convention: image uploads go to the existing `photos` bucket
-- under ${tenantId}/idea-board-${projectId}/${uuid}.${ext}. We deliberately
-- do NOT mirror these into the `photos` table — they're scratchpad
-- inputs, not gallery photos.

CREATE TABLE IF NOT EXISTS public.project_idea_board_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  project_id      UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,

  -- Authorship — nullable for forward-compat with multi-customer projects.
  customer_id     UUID REFERENCES public.customers(id) ON DELETE SET NULL,

  -- Discriminator
  kind            TEXT NOT NULL CHECK (kind IN ('image', 'link', 'note')),

  -- Per-kind payload
  image_storage_path TEXT,
  source_url      TEXT,
  thumbnail_url   TEXT,
  title           TEXT,
  notes           TEXT CHECK (notes IS NULL OR length(notes) <= 4000),

  -- Optional per-room tag. Free text, matches project_selections.room
  -- which is also free text.
  room            TEXT CHECK (room IS NULL OR length(room) <= 80),

  -- Operator-side passive read tracking. Per-item, drives the Selections
  -- tab badge unread count.
  read_by_operator_at TIMESTAMPTZ,

  -- Phase 2 promote-to-selection provenance. Declared now to avoid a
  -- follow-up migration; populated by promoteIdeaBoardItemAction.
  promoted_to_selection_id UUID REFERENCES public.project_selections(id) ON DELETE SET NULL,
  promoted_at     TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Body-shape integrity per kind. Mirrors how project_messages
  -- enforces channel + direction with a CHECK.
  CONSTRAINT pibi_payload_shape CHECK (
    (kind = 'image' AND image_storage_path IS NOT NULL)
    OR (kind = 'link' AND source_url IS NOT NULL)
    OR (kind = 'note' AND notes IS NOT NULL AND length(notes) > 0)
  )
);

-- Hot query: customer-side board render + operator-side read surface
CREATE INDEX IF NOT EXISTS idx_pibi_project_created
  ON public.project_idea_board_items (project_id, created_at DESC);

-- Operator-side unread count for the Selections tab badge
CREATE INDEX IF NOT EXISTS idx_pibi_tenant_unread
  ON public.project_idea_board_items (tenant_id, project_id)
  WHERE read_by_operator_at IS NULL;

ALTER TABLE public.project_idea_board_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY pibi_tenant_select ON public.project_idea_board_items
  FOR SELECT USING (tenant_id = public.current_tenant_id());

CREATE POLICY pibi_tenant_insert ON public.project_idea_board_items
  FOR INSERT WITH CHECK (tenant_id = public.current_tenant_id());

CREATE POLICY pibi_tenant_update ON public.project_idea_board_items
  FOR UPDATE USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

CREATE POLICY pibi_tenant_delete ON public.project_idea_board_items
  FOR DELETE USING (tenant_id = public.current_tenant_id());

COMMENT ON TABLE public.project_idea_board_items IS
  'Customer-driven inspiration scratchpad. Items are images, links (Pinterest/vendor URLs), or free-text notes. Operator sees a read-only view on the project Selections tab; no external notifications fire on customer adds.';
COMMENT ON COLUMN public.project_idea_board_items.kind IS
  'image: storage_path required. link: source_url required (thumbnail/title best-effort via og:image). note: notes text required.';
COMMENT ON COLUMN public.project_idea_board_items.promoted_to_selection_id IS
  'Phase 2: when operator promotes an item, points at the resulting project_selections row. Original idea-board item stays intact.';
