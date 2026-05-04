-- 0173_platform_admins_self_read.sql
-- Restore the proxy's ability to detect platform admins.
--
-- 0153 enabled RLS on `platform_admins` with no policies under the
-- assumption that all access went through the service role. The
-- route-protection proxy (src/proxy.ts) actually uses the anon-key
-- Supabase client with the user's session cookies — so post-0153 it
-- couldn't see any platform_admin rows, and every authenticated user
-- got bounced from /admin/* to /dashboard.
--
-- Fix: a narrow self-read policy. An authenticated user can read THEIR
-- OWN row only. This:
--   - Lets the proxy answer "am I an admin?" via auth.uid().
--   - Doesn't expose other admins' identities to the user (privacy
--     posture preserved — you can only see yourself).
--   - Service-role still bypasses RLS, so admin tooling reading the
--     full list keeps working.
--
-- Inserts/updates/deletes remain blocked for non-service-role callers,
-- as 0153 intended.

CREATE POLICY platform_admins_self_read
  ON public.platform_admins
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

COMMENT ON POLICY platform_admins_self_read ON public.platform_admins IS
  'Lets the proxy detect "am I a platform admin" via the anon-key client. Self-only — admins cannot enumerate each other through this policy.';
