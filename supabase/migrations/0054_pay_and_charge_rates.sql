-- Split hourly rate into pay (cost) and charge (billable).
-- Existing `*_hourly_rate_cents` columns keep their meaning as pay rate;
-- new `*_charge_rate_cents` columns are added alongside for billable rate.

ALTER TABLE public.worker_profiles
  ADD COLUMN IF NOT EXISTS default_charge_rate_cents INTEGER;

ALTER TABLE public.project_assignments
  ADD COLUMN IF NOT EXISTS charge_rate_cents INTEGER;

ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS charge_rate_cents INTEGER;
