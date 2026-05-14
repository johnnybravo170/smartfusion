-- Inbox V2 Phase D — track the destination row each applied draft wrote
-- to, so the universal edit / move / undo actions can find what to
-- update or delete without per-intent column proliferation.
--
-- intake_drafts.disposition='applied' rows MUST have both columns set;
-- 'pending_review' / 'dismissed' / 'error' rows leave them NULL.
-- accepted_project_id (pre-existing) continues to hold the project ref
-- regardless of destination kind so move-to-different-project can
-- update both columns atomically.

ALTER TABLE public.intake_drafts
  ADD COLUMN IF NOT EXISTS applied_destination_kind TEXT
    CHECK (applied_destination_kind IN (
      'vendor_bill', 'sub_quote', 'document', 'photo', 'message', 'project'
    ));

ALTER TABLE public.intake_drafts
  ADD COLUMN IF NOT EXISTS applied_destination_id UUID;
