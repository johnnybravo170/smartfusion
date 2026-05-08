-- Affiliate tier on tenants. Drives which commission program copy is shown
-- on the in-app Refer page and gates back-end commission accounting.
--
-- Tiers (see ops board session 731356be-f5ee-4ef1-8dc3-2d9aa09f1a74):
--   tier_1  invite-only sales partner; custom written agreement.
--   tier_2  vendor-level partner (e.g. hardware stores).
--   tier_3  public affiliate program (default for every tenant).
--
-- Tier 1 economics MUST NOT be exposed to non-tier-1 accounts in any UI.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS affiliate_tier text NOT NULL DEFAULT 'tier_3';

ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_affiliate_tier_check;

ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_affiliate_tier_check
  CHECK (affiliate_tier IN ('tier_1', 'tier_2', 'tier_3'));

COMMENT ON COLUMN public.tenants.affiliate_tier IS
  'Affiliate program tier. tier_3 = public default; tier_1/tier_2 are invite-only and have separate written agreements.';

-- Backfill: Connect Contracting is the only tier_1 partner at launch.
UPDATE public.tenants
   SET affiliate_tier = 'tier_1'
 WHERE slug = 'connect-contracting';
