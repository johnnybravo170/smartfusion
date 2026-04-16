-- 0008_quote_surfaces.sql
-- Line items on a quote. Stores the drawn polygon (GeoJSON), computed sqft,
-- and the price the pricing engine calculated at the time the line was saved.
--
-- IMPORTANT: this table intentionally does NOT carry `tenant_id`. Tenant
-- membership is inherited through `quote_id -> quotes.tenant_id`. The RLS
-- policy in 0016 uses a subquery through `quotes` to enforce isolation.
-- See DECISIONS.md entry "quote_surfaces inherited-tenant pattern" for why.
--
-- Rationale: tenant_id on a child table is redundant when the parent FK is
-- NOT NULL + ON DELETE CASCADE. Storing it twice creates a consistency
-- problem (what if they disagree?) and a write-path footgun. The cost is a
-- slightly more expensive RLS check, mitigated by the FK index on quote_id.

CREATE TABLE IF NOT EXISTS public.quote_surfaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id UUID NOT NULL REFERENCES public.quotes (id) ON DELETE CASCADE,
    surface_type TEXT NOT NULL,
    polygon_geojson JSONB,
    sqft NUMERIC(12, 2),
    price_cents INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.quote_surfaces IS 'Line items on a quote. Tenant is inherited via quote_id -> quotes.tenant_id; no direct tenant_id column by design (see migration header).';
