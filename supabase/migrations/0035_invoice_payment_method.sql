-- Add payment_method column to invoices for tracking how payment was received.
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS payment_method TEXT;

COMMENT ON COLUMN public.invoices.payment_method IS 'How the invoice was paid: stripe, cash, cheque, e-transfer, other';
