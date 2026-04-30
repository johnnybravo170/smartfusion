-- 0165_quote_templates.sql
-- Operator-saved quote templates. Companion to the built-in starter
-- templates in src/data/starter-templates — those ship in the codebase
-- as JSON; user-saved templates live here in the database, scoped per
-- tenant.
--
-- v1 schema is intentionally compact: one row per template, all of the
-- structure (buckets + lines) lives in the `snapshot` JSONB. Same shape
-- as StarterTemplate so the apply flow can branch on source without a
-- schema split. We can normalize later if querying inside the JSON
-- becomes a hot path; today it's read whole or not at all.
--
-- See the rollup discussion 2026-04-29 — saving operator-built quotes
-- as templates ("save as template") + Henry-suggested templates from
-- history both write to this table.

CREATE TABLE IF NOT EXISTS public.quote_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,

  -- Operator-facing metadata.
  label TEXT NOT NULL,
  description TEXT,

  -- 'private' = visible only to the creator, 'tenant' = visible to
  -- everyone in the tenant. v1 supports both; the picker UI honours.
  visibility TEXT NOT NULL DEFAULT 'tenant'
    CHECK (visibility IN ('private', 'tenant')),

  -- Frozen template body. Shape mirrors StarterTemplate
  -- (src/data/starter-templates/types.ts):
  -- { buckets: [{ name, section, description?, lines: [...] }] }
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Where the template came from. Drives provenance hints in the
  -- picker UI ("From your Apr 12 quote" vs "Saved by Jonathan").
  source TEXT NOT NULL DEFAULT 'save_as'
    CHECK (source IN ('save_as', 'henry_suggested')),

  /** Optional: the project the template was originally saved from.
      Useful for "go to source" link. ON DELETE SET NULL so deleting a
      project doesn't cascade-delete operator-saved templates. */
  source_project_id UUID REFERENCES public.projects (id) ON DELETE SET NULL,

  created_by UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_quote_templates_tenant
  ON public.quote_templates (tenant_id, visibility, deleted_at);

-- RLS — tenant-scoped read for everyone in the tenant; private templates
-- visible only to their creator. Writes are creator-only on update/delete
-- (operators can't stomp each other's templates).
ALTER TABLE public.quote_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_select_quote_templates ON public.quote_templates
  FOR SELECT TO authenticated
  USING (
    tenant_id = public.current_tenant_id()
    AND deleted_at IS NULL
    AND (visibility = 'tenant' OR created_by = auth.uid())
  );

CREATE POLICY tenant_insert_quote_templates ON public.quote_templates
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = public.current_tenant_id()
    AND created_by = auth.uid()
  );

CREATE POLICY tenant_update_quote_templates ON public.quote_templates
  FOR UPDATE TO authenticated
  USING (
    tenant_id = public.current_tenant_id()
    AND created_by = auth.uid()
  )
  WITH CHECK (
    tenant_id = public.current_tenant_id()
    AND created_by = auth.uid()
  );

CREATE POLICY tenant_delete_quote_templates ON public.quote_templates
  FOR DELETE TO authenticated
  USING (
    tenant_id = public.current_tenant_id()
    AND created_by = auth.uid()
  );

COMMENT ON TABLE public.quote_templates IS
  'Operator-saved + Henry-suggested quote templates. Companion to the built-in starter templates in src/data/starter-templates. Body lives in snapshot JSONB (same shape as StarterTemplate).';
