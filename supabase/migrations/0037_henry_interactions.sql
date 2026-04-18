-- Henry interaction log + token/audio usage tracking.
-- One row per completed turn (user says something → Henry responds).
-- Vertical is denormalized for fast analytics by trade.

CREATE TABLE public.henry_interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Groups turns into a conversation session (nullable; may be absent for one-shot text sends).
  conversation_id UUID,

  -- Denormalized from tenants.vertical for segment queries without a join.
  -- pressure_washing | renovation | tile | ...
  vertical TEXT,

  -- Transcripts. May be null if the user aborted mid-turn.
  user_text TEXT,
  assistant_text TEXT,

  -- Array of {name, args, result, duration_ms}
  tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb,

  model TEXT,

  -- Usage metrics
  input_tokens INT,
  output_tokens INT,
  cached_input_tokens INT,
  audio_input_seconds NUMERIC(10, 3),
  audio_output_seconds NUMERIC(10, 3),

  duration_ms INT,
  error TEXT
);

CREATE INDEX henry_interactions_tenant_created_idx
  ON public.henry_interactions (tenant_id, created_at DESC);

CREATE INDEX henry_interactions_vertical_created_idx
  ON public.henry_interactions (vertical, created_at DESC);

CREATE INDEX henry_interactions_user_created_idx
  ON public.henry_interactions (user_id, created_at DESC);

CREATE INDEX henry_interactions_conversation_idx
  ON public.henry_interactions (conversation_id)
  WHERE conversation_id IS NOT NULL;

ALTER TABLE public.henry_interactions ENABLE ROW LEVEL SECURITY;

-- Tenants can read their own rows (for a usage/history view in their own UI).
CREATE POLICY henry_interactions_tenant_select
  ON public.henry_interactions
  FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id());

-- No direct tenant INSERT/UPDATE/DELETE. Writes go through the service role
-- from /api/henry/log which validates the authenticated tenant itself.

-- ---------------------------------------------------------------------------
-- Rollup views
-- ---------------------------------------------------------------------------

-- Per-tenant per-day usage summary. Useful for billing + admin dashboards.
CREATE VIEW public.henry_usage_daily AS
SELECT
  tenant_id,
  vertical,
  date_trunc('day', created_at AT TIME ZONE 'UTC') AS day,
  COUNT(*) AS interactions,
  SUM(COALESCE(input_tokens, 0)) AS input_tokens,
  SUM(COALESCE(output_tokens, 0)) AS output_tokens,
  SUM(COALESCE(cached_input_tokens, 0)) AS cached_input_tokens,
  SUM(COALESCE(audio_input_seconds, 0)) AS audio_input_seconds,
  SUM(COALESCE(audio_output_seconds, 0)) AS audio_output_seconds,
  SUM(COALESCE(duration_ms, 0)) AS duration_ms,
  COUNT(*) FILTER (WHERE error IS NOT NULL) AS errors
FROM public.henry_interactions
GROUP BY 1, 2, 3;

-- Cross-tenant daily usage by vertical. Platform analytics.
CREATE VIEW public.henry_usage_by_vertical_daily AS
SELECT
  vertical,
  date_trunc('day', created_at AT TIME ZONE 'UTC') AS day,
  COUNT(DISTINCT tenant_id) AS active_tenants,
  COUNT(DISTINCT user_id) AS active_users,
  COUNT(*) AS interactions,
  SUM(COALESCE(input_tokens, 0)) AS input_tokens,
  SUM(COALESCE(output_tokens, 0)) AS output_tokens,
  SUM(COALESCE(audio_input_seconds, 0)) AS audio_input_seconds,
  SUM(COALESCE(audio_output_seconds, 0)) AS audio_output_seconds
FROM public.henry_interactions
GROUP BY 1, 2;

-- Most common tool calls by vertical. Marketing + product insight gold.
CREATE VIEW public.henry_tool_usage_by_vertical AS
SELECT
  vertical,
  tool_call ->> 'name' AS tool_name,
  COUNT(*) AS call_count,
  COUNT(DISTINCT tenant_id) AS distinct_tenants
FROM public.henry_interactions,
     jsonb_array_elements(tool_calls) AS tool_call
GROUP BY 1, 2;
