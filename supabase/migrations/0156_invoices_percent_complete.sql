-- 0156_invoices_percent_complete
--
-- Project draws can carry a "% complete" the operator sets at draw time
-- (e.g. "Draw #2 — 40% complete"). Lives on the invoice row alongside
-- doc_type='draw' / tax_inclusive=true. Optional — null for invoices /
-- final invoices that don't track milestone progress.

ALTER TABLE public.invoices
  ADD COLUMN percent_complete INTEGER NULL
    CHECK (percent_complete IS NULL OR (percent_complete BETWEEN 0 AND 100));

COMMENT ON COLUMN public.invoices.percent_complete IS
  'Operator-set milestone % for draws. 0-100 inclusive. Null when not tracking.';
