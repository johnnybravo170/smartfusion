-- 0143_switch_active_tenant_fn.sql
-- RPC for atomically switching the user's active tenant_members row.
--
-- Two-step swap is required because the partial unique index
-- `tenant_members_one_active_per_user` (added in 0142) is checked per-row
-- inside an UPDATE statement, so we can't toggle two rows in a single
-- UPDATE without risking a transient duplicate. SECURITY DEFINER lets
-- us bypass RLS for the writes (RLS scopes to current_tenant_id, which
-- would only show the row we're about to deactivate).

CREATE OR REPLACE FUNCTION public.set_active_tenant_member(target_tenant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_members
    WHERE user_id = v_user_id AND tenant_id = target_tenant_id
  ) THEN
    RAISE EXCEPTION 'Not a member of target tenant';
  END IF;

  UPDATE public.tenant_members
    SET is_active_for_user = false
    WHERE user_id = v_user_id AND is_active_for_user = true;

  UPDATE public.tenant_members
    SET is_active_for_user = true
    WHERE user_id = v_user_id AND tenant_id = target_tenant_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_active_tenant_member(UUID) TO authenticated;

COMMENT ON FUNCTION public.set_active_tenant_member(UUID) IS
  'Switches the caller''s active tenant_members row to the target tenant. SECURITY DEFINER to bypass RLS during the two-step swap. See card c2bb8ed0.';
