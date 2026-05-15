-- Per-tenant inbound email aliases.
--
-- Lets a tenant register an address on their own domain (or a subdomain
-- delegated to Postmark inbound MX), e.g. `hello@connectcontracting.ca`.
-- Mail to that address routes into the universal intake pipeline as a
-- fresh lead, and the operator gets an email notification with a deep
-- link to /inbox/intake/<id>.
--
-- Lookup is on the To header of an inbound Postmark webhook. Empty match
-- falls through to the existing `henry@heyhenry.io` shared-inbox flow
-- (the `resolve_inbound_sender` From-based path). The two paths are
-- mutually exclusive — alias addresses never overlap with `henry@`.
--
-- V1: addresses are seeded by platform admin (set verification_status =
-- 'verified' manually). DNS verification flow + per-tenant UI to add
-- addresses lives on the Marketing tab card. Out of scope here.

CREATE TABLE IF NOT EXISTS public.tenant_inbound_addresses (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  -- Always lowercased on insert (CHECK below). One address routes to one
  -- tenant — UNIQUE across the platform.
  address               text NOT NULL UNIQUE,
  -- Denormalised bare domain for "who owns this domain?" queries and
  -- for the verification flow (a single TXT record under the domain
  -- covers every alias on it).
  domain                text NOT NULL,
  verification_status   text NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending', 'verified', 'failed')),
  verification_token    text,
  verified_at           timestamptz,
  dns_checked_at        timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (address = lower(address)),
  CHECK (domain = lower(domain))
);

-- Hot path: webhook resolves a verified address on every inbound email.
-- Partial index keeps it tight — unverified rows aren't routable.
CREATE INDEX IF NOT EXISTS idx_tenant_inbound_addresses_verified
  ON public.tenant_inbound_addresses (address)
  WHERE verification_status = 'verified';

CREATE INDEX IF NOT EXISTS idx_tenant_inbound_addresses_tenant
  ON public.tenant_inbound_addresses (tenant_id);

ALTER TABLE public.tenant_inbound_addresses ENABLE ROW LEVEL SECURITY;

-- Tenant members can read their own aliases. Writes happen via service
-- role from the webhook + admin-driven seed scripts (V1) — mirrors the
-- tenant_deletion_requests / widget_configs RLS pattern.
CREATE POLICY tenant_inbound_addresses_select_tenant
  ON public.tenant_inbound_addresses
  FOR SELECT TO authenticated
  USING (tenant_id IN (
    SELECT tm.tenant_id FROM public.tenant_members tm WHERE tm.user_id = auth.uid()
  ));

COMMENT ON TABLE public.tenant_inbound_addresses IS
  'Per-tenant inbound email aliases (e.g. hello@<tenant-domain>) that route into the universal intake pipeline as fresh leads.';
COMMENT ON COLUMN public.tenant_inbound_addresses.address IS
  'Lowercased fully-qualified email address. Unique across all tenants.';
COMMENT ON COLUMN public.tenant_inbound_addresses.domain IS
  'Bare lowercased domain (e.g. "connectcontracting.ca"). Denormalised from address for verification flow.';
