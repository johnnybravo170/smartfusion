-- Add 'bookkeeper' role to tenant_members.
--
-- Third user type alongside owner/admin/member/worker. External
-- accountants get invited by the tenant owner, land on /bk with a
-- scoped view into the tenant's financial surfaces (expenses, bills,
-- invoices, GST remittance, T4A/1099 roll-ups, year-end exports).
--
-- Deliberately NOT adding per-table RLS policies for this role. Like
-- worker, the bookkeeper sees same-tenant rows via the existing
-- `current_tenant_id()` scoping; UI-level page routes enforce what's
-- actually rendered (customer PII isn't rendered on /bk pages). A
-- follow-up card can harden this with column-level RLS if needed.

BEGIN;

ALTER TABLE public.tenant_members
  DROP CONSTRAINT tenant_members_role_check;

ALTER TABLE public.tenant_members
  ADD CONSTRAINT tenant_members_role_check
    CHECK (role IN ('owner', 'admin', 'member', 'worker', 'bookkeeper'));

COMMIT;
