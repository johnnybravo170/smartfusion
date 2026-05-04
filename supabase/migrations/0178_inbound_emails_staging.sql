-- Pivot inbound_emails to the henry@heyhenry.io single-inbox model.
--
-- Adds:
--   - status='bounced' for unknown-sender records
--   - applied_sub_quote_id (FK to project_sub_quotes) for the new
--     hand-off-to-existing-sub-quote-form confirm flow
--   - resolve_inbound_sender(text) RPC: tenant-resolution by sender email
--
-- Keeps 'auto_applied' status enum value (historical rows from the Apr 20
-- pre-pivot deploy) and the legacy applied_cost_line_ids column (no longer
-- written, but old data stays readable).
--
-- See INBOUND_EMAIL_PLAN.md.

ALTER TABLE public.inbound_emails
  DROP CONSTRAINT inbound_emails_status_check,
  ADD CONSTRAINT inbound_emails_status_check
    CHECK (status IN ('pending', 'processing', 'auto_applied', 'needs_review',
                      'applied', 'rejected', 'error', 'bounced'));

ALTER TABLE public.inbound_emails
  ADD COLUMN IF NOT EXISTS applied_sub_quote_id UUID
    REFERENCES public.project_sub_quotes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inbound_emails_applied_sub_quote
  ON public.inbound_emails(applied_sub_quote_id)
  WHERE applied_sub_quote_id IS NOT NULL;

-- Sender→tenant lookup. SECURITY DEFINER so we can join auth.users without
-- exposing the auth schema. Returns NULL for unknown OR ambiguous (multi-
-- tenant) senders — both are treated as bounce conditions.
CREATE OR REPLACE FUNCTION public.resolve_inbound_sender(p_email text)
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_ids uuid[];
BEGIN
  SELECT array_agg(tm.tenant_id)
  INTO v_ids
  FROM public.tenant_members tm
  JOIN auth.users u ON u.id = tm.user_id
  WHERE lower(u.email) = lower(trim(p_email))
    AND tm.role IN ('owner', 'admin');

  IF v_ids IS NULL OR array_length(v_ids, 1) <> 1 THEN
    RETURN NULL;
  END IF;
  RETURN v_ids[1];
END
$$;

REVOKE ALL ON FUNCTION public.resolve_inbound_sender(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_inbound_sender(text) TO service_role;
