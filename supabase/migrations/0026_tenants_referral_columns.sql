-- 0026_tenants_referral_columns.sql
-- Add referral tracking columns to the tenants table.
-- referred_by_code: the referral code used at signup (if any).
-- trial_ends_at: extended trial end date for referred signups.

ALTER TABLE public.tenants
    ADD COLUMN IF NOT EXISTS referred_by_code TEXT,
    ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
