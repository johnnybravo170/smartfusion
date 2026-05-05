-- ============================================================
-- Multi-email recipients per customer.
--
-- Some customers want their estimate / invoice copied to a spouse,
-- bookkeeper, business partner, or lender on every send. Rather than
-- making the operator re-type those addresses every time, store them
-- on the customer row.
--
-- Per-send opt-out happens in the UI: the send bar shows a checklist
-- of [primary + every additional_email] with all boxes pre-checked,
-- and the operator can uncheck or add a one-off. The action accepts
-- an optional recipientEmails override and defaults to the union of
-- primary + additional_emails when not provided.
--
-- Storage: text[] is sufficient — typical N is 1-3, no need for a
-- separate emails table or per-email flags.
-- ============================================================

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS additional_emails text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.customers.additional_emails IS
  'Extra email addresses that should receive customer-facing communications (estimates, invoices, change orders) by default. Per-send checklist in the UI lets the operator opt out for any specific message.';
