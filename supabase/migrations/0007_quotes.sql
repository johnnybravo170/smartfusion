-- 0007_quotes.sql
-- A quote is a priced bundle of surfaces attached to a customer.
-- `customer_id` uses ON DELETE RESTRICT so we never silently orphan financial
-- records; if someone deletes a customer they must deal with their quotes.

CREATE TABLE IF NOT EXISTS public.quotes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
    customer_id UUID REFERENCES public.customers (id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'expired')),
    subtotal_cents INTEGER NOT NULL DEFAULT 0,
    tax_cents INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    pdf_url TEXT,
    sent_at TIMESTAMPTZ,
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.quotes IS 'Priced bundle of surfaces for a customer. See quote_surfaces for line items.';
