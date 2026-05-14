-- Inbound Email V2 — converge inbound_emails with intake_drafts as the
-- universal capture pipeline. See INBOUND_EMAIL_V2_PLAN.md.
--
-- Purely additive on the intake_drafts side. Collapses
-- inbound_emails.status to envelope-only (operator-action lifecycle
-- moves to intake_drafts.disposition). Legacy inbound_emails rows
-- backfill to status='routed_to_intake' with intake_draft_id NULL —
-- they were already actioned in V1 so won't surface in the new inbox
-- (banner / list queries use INNER joins through intake_draft_id).

-- 1. Source — where this draft entered the system. Required for the
--    universal /inbox/intake filter ("Email", "Drop zone", etc).
ALTER TABLE public.intake_drafts
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'lead_form'
    CHECK (source IN ('email', 'project_drop', 'lead_form', 'voice', 'web_share'));

-- 2. Disposition — operator-action lifecycle (separate concern from the
--    parser-lifecycle `status` column). Owned by the inbox UX.
ALTER TABLE public.intake_drafts
  ADD COLUMN IF NOT EXISTS disposition TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (disposition IN ('pending_review', 'applied', 'dismissed', 'error'));

-- 3. Audit — who applied it, when. Covers all sources, not just email.
ALTER TABLE public.intake_drafts
  ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;

ALTER TABLE public.intake_drafts
  ADD COLUMN IF NOT EXISTS applied_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- 4. Link from inbound_emails to its intake_draft. Email is the envelope;
--    the draft is the unit of work. Index for the banner / inbox joins.
ALTER TABLE public.inbound_emails
  ADD COLUMN IF NOT EXISTS intake_draft_id UUID REFERENCES public.intake_drafts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inbound_emails_intake_draft
  ON public.inbound_emails(intake_draft_id)
  WHERE intake_draft_id IS NOT NULL;

-- 5. Inbox filter index — disposition + tenant. Hot path for the new
--    /inbox/intake page query. Partial to keep the index small.
CREATE INDEX IF NOT EXISTS idx_intake_drafts_tenant_disposition
  ON public.intake_drafts(tenant_id, disposition, created_at DESC)
  WHERE disposition IN ('pending_review', 'error');

-- 6. Drop the OLD inbound_emails.status check constraint FIRST so the
--    backfill UPDATE in step 7 isn't blocked by it. Add the new
--    envelope-only constraint AFTER the backfill so it accepts the
--    coerced rows.
ALTER TABLE public.inbound_emails
  DROP CONSTRAINT IF EXISTS inbound_emails_status_check;

-- 7. Backfill V1 statuses → 'routed_to_intake'; preserve 'bounced'.
--    Pre-V2 rows have NO draft (intake_draft_id stays NULL) and were
--    already actioned — they won't surface in V2 surfaces because
--    every V2 list query INNER-joins through intake_draft_id.
UPDATE public.inbound_emails
   SET status = 'routed_to_intake'
 WHERE status IN ('pending', 'processing', 'auto_applied', 'needs_review',
                  'applied', 'rejected', 'error');

-- 8. Add the envelope-only constraint now that all rows comply.
ALTER TABLE public.inbound_emails
  ADD CONSTRAINT inbound_emails_status_check
    CHECK (status IN ('pending', 'routed_to_intake', 'bounced'));
