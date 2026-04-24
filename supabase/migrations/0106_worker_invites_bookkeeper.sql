-- Allow 'bookkeeper' role on worker_invites.
--
-- Pairs with 0105 (adds 'bookkeeper' to tenant_members.role). The
-- invite is a scaffold that eventually creates a tenant_members row
-- with the invite's role, so both CHECKs must agree.

BEGIN;

ALTER TABLE public.worker_invites
  DROP CONSTRAINT IF EXISTS worker_invites_role_check;

ALTER TABLE public.worker_invites
  ADD CONSTRAINT worker_invites_role_check
    CHECK (role IN ('worker', 'member', 'bookkeeper'));

COMMIT;
