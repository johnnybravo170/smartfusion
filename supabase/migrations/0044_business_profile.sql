-- 0044_business_profile.sql
-- Business profile fields on tenants + operator profile on tenant_members.
--
-- Drives: closeout email header (logo, operator signoff, real review URL),
-- public gallery footer (website, socials), invoice/quote PDF letterhead
-- (address, phone), SMS opt-out footer (business phone).
--
-- Every column is nullable — existing tenants keep working unchanged; the
-- settings UI is where operators fill these in.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS address_line1 TEXT,
  ADD COLUMN IF NOT EXISTS address_line2 TEXT,
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS postal_code TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS contact_email TEXT,
  ADD COLUMN IF NOT EXISTS website_url TEXT,
  ADD COLUMN IF NOT EXISTS review_url TEXT,
  ADD COLUMN IF NOT EXISTS logo_storage_path TEXT,
  -- socials shape: { instagram, facebook, tiktok, youtube, google_business, linkedin, x }
  -- all optional strings, free-form URLs. Kept JSONB so we can add platforms
  -- without another migration.
  ADD COLUMN IF NOT EXISTS socials JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.tenant_members
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name TEXT,
  ADD COLUMN IF NOT EXISTS title TEXT; -- "Owner", "Estimator", etc.
