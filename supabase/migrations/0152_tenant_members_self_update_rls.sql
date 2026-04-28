-- 0152_tenant_members_self_update_rls
--
-- tenant_members had SELECT + INSERT policies but no UPDATE policy.
-- Result: the operator profile form's save call (updateOperatorProfileAction)
-- ran an UPDATE that RLS silently filtered to zero rows. The action
-- returned ok:true (Supabase doesn't error on RLS-filtered no-ops), the
-- "Saved" toast appeared, and on reload the form still showed the old
-- values. Discovered while investigating "I filled in JVD's name and
-- hourly rate, saved, came back, nothing was saved."
--
-- This adds a self-update policy: a member may update their own row
-- (user_id = auth.uid()) within their active tenant.
--
-- Out of scope for this card: owner/admin updating *other* members'
-- rows. That's a separate workflow with its own audit needs — capture
-- as a follow-up if/when team-management UI grows beyond invites.

BEGIN;

CREATE POLICY tenant_members_update_self ON public.tenant_members
  FOR UPDATE TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND tenant_id = public.current_tenant_id()
  )
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND tenant_id = public.current_tenant_id()
  );

COMMIT;
