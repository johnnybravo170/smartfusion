-- 0204_project_selections_customer_authored.sql
-- Customer-side write path for the Selections tab.
--
-- The portal grows a Selections tab where the customer can record what
-- they've actually chosen — paint chips, tile picks, fixture model
-- numbers, etc. — without going through the operator. The same table
-- continues to hold the operator-authored install spec; a `created_by`
-- column distinguishes the two so the operator UI can flag rows the
-- customer added and so customer-side writes can only edit/delete
-- their own.
--
-- A single inline `image_storage_path` column captures the customer's
-- photo upload. Operator's existing multi-photo `photo_refs` flow is
-- unchanged.

ALTER TABLE public.project_selections
  ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT 'operator'
    CHECK (created_by IN ('operator', 'customer')),
  ADD COLUMN IF NOT EXISTS image_storage_path TEXT;

COMMENT ON COLUMN public.project_selections.created_by IS
  'Whether this row was authored by the operator (the install spec) or the customer (their own record). Customers can edit/delete only their own rows; operators can edit any.';
COMMENT ON COLUMN public.project_selections.image_storage_path IS
  'Single inline image uploaded by the customer (path in the photos bucket under ${tenantId}/idea-board-${projectId}/...). Distinct from photo_refs which references rows in the photos table.';
