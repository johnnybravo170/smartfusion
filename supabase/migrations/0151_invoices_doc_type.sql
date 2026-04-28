-- 0151_invoices_doc_type
--
-- Indicate that an invoice is actually a progress draw (a payment
-- request against an open contract value), not a final bill for
-- completed scope. Customer-facing rendering branches on this.
--
-- Interim: a flag on the existing invoices table. The proper draws
-- model — separate `project_draws` table with milestone scheduling,
-- retention, and earned-vs-unearned reconciliation against final
-- invoices — is a follow-up card. Any rows with doc_type='draw' will
-- migrate cleanly when that lands.

BEGIN;

ALTER TABLE public.invoices
  ADD COLUMN doc_type TEXT NOT NULL DEFAULT 'invoice'
    CHECK (doc_type IN ('invoice', 'draw'));

COMMENT ON COLUMN public.invoices.doc_type IS
  'invoice = bill for completed scope. draw = progress payment request against an open contract. Customer-facing labels and accounting treatment branch on this. Interim — proper draws model lands in a separate project_draws table later.';

COMMIT;
