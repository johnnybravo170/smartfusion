-- Enable RLS on platform_admins and ar_suppression_list.
--
-- Both tables are server-only (service-role reads/writes), but RLS was
-- DISABLEd, and Supabase's default GRANTs give anon/authenticated full
-- CRUD on every public table. Net effect: anyone with the anon key could
-- read or modify either table — including inserting themselves into
-- platform_admins. Supabase advisor flagged it as rls_disabled_in_public.
--
-- Enabling RLS with no policies blocks anon/authenticated entirely while
-- leaving service-role (which bypasses RLS) untouched.

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ar_suppression_list ENABLE ROW LEVEL SECURITY;
