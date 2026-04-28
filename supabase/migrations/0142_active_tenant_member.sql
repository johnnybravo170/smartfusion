-- 0142_active_tenant_member.sql
-- Multi-tenant account switching: a single auth user can belong to multiple
-- tenants and switch between them. The "active" tenant is per-user and stored
-- on tenant_members so RLS doesn't need to change shape — current_tenant_id()
-- just gains an `is_active_for_user = true` filter.
--
-- See kanban card c2bb8ed0 for the full architecture.

-- ============================================================
-- 1. Active-membership flag on tenant_members
-- ============================================================
ALTER TABLE public.tenant_members
  ADD COLUMN IF NOT EXISTS is_active_for_user BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- 2. Tenant cosmetics + demo flag
-- ============================================================
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS accent_color TEXT,
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- 3. Allow `personal` as a vertical
-- The original CHECK was added inline on ALTER TABLE ADD COLUMN in 0031,
-- which produces the auto-named constraint `tenants_vertical_check`.
-- ============================================================
ALTER TABLE public.tenants DROP CONSTRAINT IF EXISTS tenants_vertical_check;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_vertical_check
  CHECK (vertical IN ('pressure_washing', 'renovation', 'tile', 'personal'));

-- ============================================================
-- 4. Backfill: every existing user gets exactly one active membership
-- (the earliest one they joined). Idempotent — only flips rows where no
-- active row exists yet for that user.
-- ============================================================
WITH first_per_user AS (
  SELECT DISTINCT ON (user_id) id
  FROM public.tenant_members
  WHERE user_id NOT IN (
    SELECT user_id FROM public.tenant_members WHERE is_active_for_user = true
  )
  ORDER BY user_id, created_at
)
UPDATE public.tenant_members
SET is_active_for_user = true
WHERE id IN (SELECT id FROM first_per_user);

-- ============================================================
-- 5. Enforce one-active-per-user at the DB level
-- Partial unique index — only the rows where is_active_for_user = true
-- need to be unique per user_id.
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS tenant_members_one_active_per_user
  ON public.tenant_members (user_id)
  WHERE is_active_for_user = true;

-- ============================================================
-- 6. Update current_tenant_id() to honor the active flag
-- 293 RLS policies reference this function — the body change is the
-- entire RLS-side implementation of multi-tenancy.
-- ============================================================
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT tm.tenant_id
    FROM public.tenant_members tm
    WHERE tm.user_id = auth.uid()
      AND tm.is_active_for_user = true
    LIMIT 1;
$$;

COMMENT ON FUNCTION public.current_tenant_id() IS
    'Returns the tenant_id of the currently active membership for the auth user. SECURITY DEFINER to avoid RLS recursion on tenant_members. Updated in 0142 to honor is_active_for_user; see card c2bb8ed0.';
