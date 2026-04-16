-- 0011_invoices.sql
-- Invoicing via Stripe Connect Standard (§13.2). Stripe IDs are tracked so we
-- can reconcile webhooks. `customer_id` uses RESTRICT for the same reason as
-- quotes: we never silently orphan financial records.

CREATE TABLE IF NOT EXISTS public.invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
    customer_id UUID REFERENCES public.customers (id) ON DELETE RESTRICT,
    job_id UUID REFERENCES public.jobs (id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'sent', 'paid', 'void')),
    amount_cents INTEGER NOT NULL DEFAULT 0,
    tax_cents INTEGER NOT NULL DEFAULT 0,
    stripe_invoice_id TEXT,
    stripe_payment_intent_id TEXT,
    pdf_url TEXT,
    sent_at TIMESTAMPTZ,
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.invoices IS 'Invoices for completed jobs. Money numbers in cents. Stripe IDs populated by webhook handlers.';
