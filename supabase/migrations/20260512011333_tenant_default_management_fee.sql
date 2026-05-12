-- Tenant-level default management fee rate used when creating new projects.
-- Project rows still carry their own management_fee_rate (set at create time
-- from this default; editable per-project via ManagementFeeEditor). This
-- column only influences the *initial* value for new projects.
--
-- Stored as numeric(4,3) to match projects.management_fee_rate semantics
-- (0.000–1.000 = 0–100%). Default 0.120 preserves existing behavior for
-- tenants that never touch the setting.

alter table public.tenants
  add column if not exists default_management_fee_rate numeric(4, 3) not null default 0.120
    check (default_management_fee_rate >= 0 and default_management_fee_rate <= 0.500);
