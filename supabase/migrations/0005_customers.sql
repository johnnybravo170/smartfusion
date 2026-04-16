-- 0005_customers.sql
-- CRM table. Every quote/job/invoice attaches to a customer.
-- Soft-delete column (`deleted_at`) is added in 0018 per §13.9.

CREATE TABLE IF NOT EXISTS public.customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('residential', 'commercial', 'agent')),
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    address_line1 TEXT,
    city TEXT,
    province TEXT,
    postal_code TEXT,
    lat NUMERIC(10, 7),
    lng NUMERIC(10, 7),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.customers IS 'End-customers of a tenant (homeowners, commercial clients, realtors). Drizzle schema: src/lib/db/schema/customers.ts.';
