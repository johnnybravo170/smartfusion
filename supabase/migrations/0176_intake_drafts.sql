-- Persisted intake drafts.
--
-- The "New Project" intake was a single in-memory action: upload audio →
-- Whisper → fold into prompt → Opus parse → return to client. Two
-- problems with that:
--
--   1) Pipeline > 60 s page maxDuration trashes the transcript with
--      nothing recoverable; operator re-uploads + we re-burn Whisper.
--   2) No durable artifact to iterate on, attach more inputs to, run
--      a "second pass with thinking" against, or build an eval set
--      from. Each intake is one-shot and ephemeral.
--
-- This table holds the durable state. The flow becomes:
--
--   Stage A — `createIntakeDraftAction(formData)`:
--     creates a draft row, runs Whisper, persists transcript +
--     artifact references, returns draft id.
--
--   Stage B — `parseIntakeDraftAction(draftId)`:
--     reads the draft, runs Opus, writes ai_extraction.v1, sets
--     status=ready. Retry-able. Failure leaves transcript + artifacts
--     intact for diagnosis.
--
-- ai_extraction is the same `{ v1, v2, active }` envelope used by
-- `project_memos` (migration 0174) so the second-pass thinking button
-- can be wired identically when we get to it.
--
-- artifacts is a jsonb array of `{ path, name, mime, size, kind }`
-- where `kind` ∈ ('audio', 'image', 'pdf'). The `path` points into
-- the `intake-audio` storage bucket; deletion is deferred until the
-- draft is accepted (project created) or expires (TTL cleanup, future).

CREATE TABLE IF NOT EXISTS public.intake_drafts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'transcribing', 'extracting', 'rethinking', 'ready', 'failed')),
  customer_name   TEXT,
  pasted_text     TEXT,
  transcript      TEXT,
  artifacts       JSONB NOT NULL DEFAULT '[]'::jsonb,
  ai_extraction   JSONB,
  parsed_by       TEXT,
  error_message   TEXT,
  -- Once accepted, references the project that consumed this draft. Lets
  -- us correlate drafts to outcomes for eval / quality work.
  accepted_project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_intake_drafts_tenant_created
  ON public.intake_drafts (tenant_id, created_at DESC);

-- updated_at touched on every change so the page can poll for status
-- transitions cheaply.
CREATE OR REPLACE FUNCTION public.intake_drafts_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER intake_drafts_touch_updated_at_trg
  BEFORE UPDATE ON public.intake_drafts
  FOR EACH ROW EXECUTE FUNCTION public.intake_drafts_touch_updated_at();

-- RLS: tenant isolation. Workers in the tenant can read/write their
-- own drafts. Cross-tenant access denied.
ALTER TABLE public.intake_drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_select_intake_drafts ON public.intake_drafts
  FOR SELECT USING (tenant_id = current_tenant_id());

CREATE POLICY tenant_insert_intake_drafts ON public.intake_drafts
  FOR INSERT WITH CHECK (tenant_id = current_tenant_id());

CREATE POLICY tenant_update_intake_drafts ON public.intake_drafts
  FOR UPDATE USING (tenant_id = current_tenant_id());

CREATE POLICY tenant_delete_intake_drafts ON public.intake_drafts
  FOR DELETE USING (tenant_id = current_tenant_id());
