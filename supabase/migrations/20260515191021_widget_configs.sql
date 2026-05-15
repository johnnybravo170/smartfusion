-- Widget configs — per-tenant token + cosmetic config for the embeddable
-- conversational lead-intake widget (epic:leads-widget).
--
-- One row per tenant for V1. Token is the only secret the embed script
-- needs (`<script data-token="wgt_...">`) so the widget can call
-- /api/widget/chat and /api/widget/signed-upload-url without a session.
--
-- Token is treated as a public-key analogue: it identifies the tenant on
-- a public endpoint but doesn't authenticate a human user. Abuse control
-- is rate-limit + origin-allowlist, not secrecy of the token.

CREATE TABLE IF NOT EXISTS public.widget_configs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  token                 text NOT NULL UNIQUE,
  enabled               boolean NOT NULL DEFAULT true,
  photos_enabled        boolean NOT NULL DEFAULT true,
  -- Hex including the leading '#', e.g. '#ff8800'. NULL = widget default.
  accent_color          text,
  -- True when the tenant's plan allows hiding the "Powered by Henry" badge
  -- AND they've chosen to hide it. The UI gates the toggle on plan.
  white_label_disabled  boolean NOT NULL DEFAULT false,
  -- Origins that may embed the widget. Empty = anywhere. When non-empty,
  -- /api/widget/* checks the request `Origin` header against this list.
  allowed_origins       text[] NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- One config per tenant for V1. Drop this if/when we want per-page widgets.
CREATE UNIQUE INDEX IF NOT EXISTS uq_widget_configs_tenant
  ON public.widget_configs (tenant_id);

-- Hot path on /api/widget/chat is the token lookup.
CREATE INDEX IF NOT EXISTS idx_widget_configs_token
  ON public.widget_configs (token);

ALTER TABLE public.widget_configs ENABLE ROW LEVEL SECURITY;

-- Tenant members can read their own widget config. Service role handles
-- all writes (mirrors the tenant_deletion_requests pattern — owner/admin
-- writes happen via SECURITY DEFINER server actions, not direct RLS).
CREATE POLICY widget_configs_select_tenant ON public.widget_configs
  FOR SELECT TO authenticated
  USING (tenant_id IN (
    SELECT tm.tenant_id FROM public.tenant_members tm WHERE tm.user_id = auth.uid()
  ));

COMMENT ON TABLE public.widget_configs IS
  'Per-tenant config for the embeddable conversational lead-intake widget. Token is the public identifier the embed script presents to /api/widget/*.';
COMMENT ON COLUMN public.widget_configs.token IS
  'Public-key-style identifier. Format: wgt_<24 url-safe chars>. Not secret; abuse-controlled by rate limits + allowed_origins.';
COMMENT ON COLUMN public.widget_configs.allowed_origins IS
  'CORS allow-list of origins permitted to embed the widget. Empty array = any origin (V1 default).';
