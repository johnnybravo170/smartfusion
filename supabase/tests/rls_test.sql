-- rls_test.sql
-- pgTAP tests for every tenant-scoped table. For each table we prove:
--   1. A user in tenant A can INSERT into (and SELECT from) tenant A.
--   2. A user in tenant B cannot SELECT tenant A's rows (sees 0).
--   3. A user in tenant B cannot INSERT a row with tenant A's tenant_id
--      (RLS policy violation).
-- Plus one test in the `current_tenant_id()` section that proves session-level
-- revocation: removing a user from tenant_members makes them invisible to
-- their own data immediately, within the same session.
--
-- How auth is faked in pgTAP:
--   Supabase's `auth.uid()` reads the `sub` claim from the
--   `request.jwt.claims` setting (see GoTrue's auth.uid() SQL helper). We set
--   the setting with `set_config(...)` inside each test block and switch the
--   role to `authenticated` so RLS actually kicks in. Without the role switch
--   we would be running as superuser, which bypasses RLS.
--
-- Fixture IDs (reused across tests):
--   Tenant A  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
--   Tenant B  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
--   User 1 (A) = '11111111-1111-1111-1111-111111111111'
--   User 2 (B) = '22222222-2222-2222-2222-222222222222'

begin;

-- pgTAP lives in extensions schema on Supabase.
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

-- 4 policies per tenant-scoped table (select own / deny other-select /
--   insert own / deny other-insert) times 11 tables (customers,
--   service_catalog, quotes, quote_surfaces, jobs, photos, invoices, todos,
--   worklog_entries, audit_log, data_exports) = 44.
-- Plus 1 revocation test = 45 total assertions.
select plan(45);

-- ============================================================================
-- Fixture setup (bypasses RLS because we're superuser here).
-- ============================================================================
insert into public.tenants (id, name) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Tenant A'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Tenant B');

insert into public.tenant_members (tenant_id, user_id, role) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner');

-- Helper: act as a given user. Sets the JWT claim and switches to the
-- `authenticated` role so RLS policies apply.
create or replace function test_act_as(user_id uuid) returns void
language plpgsql as $$
begin
    perform set_config('request.jwt.claims', json_build_object('sub', user_id::text, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
end;
$$;

-- ============================================================================
-- customers
-- ============================================================================

select test_act_as('11111111-1111-1111-1111-111111111111');

select lives_ok(
    $$insert into public.customers (tenant_id, type, name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'residential', 'Alpha Smith')$$,
    'customers: tenant A user can insert into tenant A'
);
select is(
    (select count(*)::int from public.customers),
    1,
    'customers: tenant A user sees the 1 row they just inserted'
);

select test_act_as('22222222-2222-2222-2222-222222222222');
select is(
    (select count(*)::int from public.customers),
    0,
    'customers: tenant B user cannot see tenant A row'
);
select throws_ok(
    $$insert into public.customers (tenant_id, type, name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'residential', 'Hacker')$$,
    '42501',
    null,
    'customers: tenant B user cannot insert under tenant A'
);

-- ============================================================================
-- service_catalog
-- ============================================================================

select test_act_as('11111111-1111-1111-1111-111111111111');
select lives_ok(
    $$insert into public.service_catalog (tenant_id, surface_type, label) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'driveway', 'Driveway')$$,
    'service_catalog: tenant A user can insert into tenant A'
);
select is(
    (select count(*)::int from public.service_catalog),
    1,
    'service_catalog: tenant A user sees their own row'
);

select test_act_as('22222222-2222-2222-2222-222222222222');
select is(
    (select count(*)::int from public.service_catalog),
    0,
    'service_catalog: tenant B user sees 0 tenant A rows'
);
select throws_ok(
    $$insert into public.service_catalog (tenant_id, surface_type, label) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'deck', 'Deck')$$,
    '42501',
    null,
    'service_catalog: tenant B user cannot insert under tenant A'
);

-- ============================================================================
-- quotes (also seeds a tenant-A quote used by quote_surfaces below)
-- ============================================================================

select test_act_as('11111111-1111-1111-1111-111111111111');
select lives_ok(
    $$insert into public.quotes (id, tenant_id, status) values ('c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'draft')$$,
    'quotes: tenant A user can insert into tenant A'
);
select is(
    (select count(*)::int from public.quotes),
    1,
    'quotes: tenant A user sees their own row'
);

select test_act_as('22222222-2222-2222-2222-222222222222');
select is(
    (select count(*)::int from public.quotes),
    0,
    'quotes: tenant B user sees 0 tenant A rows'
);
select throws_ok(
    $$insert into public.quotes (tenant_id, status) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'draft')$$,
    '42501',
    null,
    'quotes: tenant B user cannot insert under tenant A'
);

-- ============================================================================
-- quote_surfaces (tenant inherited via quote_id)
-- ============================================================================

select test_act_as('11111111-1111-1111-1111-111111111111');
select lives_ok(
    $$insert into public.quote_surfaces (quote_id, surface_type) values ('c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1', 'driveway')$$,
    'quote_surfaces: tenant A user can insert against tenant A quote'
);
select is(
    (select count(*)::int from public.quote_surfaces),
    1,
    'quote_surfaces: tenant A user sees the line they inserted'
);

select test_act_as('22222222-2222-2222-2222-222222222222');
select is(
    (select count(*)::int from public.quote_surfaces),
    0,
    'quote_surfaces: tenant B user sees 0 tenant A lines'
);
select throws_ok(
    $$insert into public.quote_surfaces (quote_id, surface_type) values ('c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1', 'deck')$$,
    '42501',
    null,
    'quote_surfaces: tenant B user cannot insert against tenant A quote'
);

-- ============================================================================
-- jobs
-- ============================================================================

select test_act_as('11111111-1111-1111-1111-111111111111');
select lives_ok(
    $$insert into public.jobs (tenant_id, status) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'booked')$$,
    'jobs: tenant A user can insert into tenant A'
);
select is(
    (select count(*)::int from public.jobs),
    1,
    'jobs: tenant A user sees their own row'
);

select test_act_as('22222222-2222-2222-2222-222222222222');
select is(
    (select count(*)::int from public.jobs),
    0,
    'jobs: tenant B user sees 0 tenant A rows'
);
select throws_ok(
    $$insert into public.jobs (tenant_id, status) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'booked')$$,
    '42501',
    null,
    'jobs: tenant B user cannot insert under tenant A'
);

-- ============================================================================
-- photos
-- ============================================================================

select test_act_as('11111111-1111-1111-1111-111111111111');
select lives_ok(
    $$insert into public.photos (tenant_id, storage_path) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'tenant-a/path.jpg')$$,
    'photos: tenant A user can insert into tenant A'
);
select is(
    (select count(*)::int from public.photos),
    1,
    'photos: tenant A user sees their own row'
);

select test_act_as('22222222-2222-2222-2222-222222222222');
select is(
    (select count(*)::int from public.photos),
    0,
    'photos: tenant B user sees 0 tenant A rows'
);
select throws_ok(
    $$insert into public.photos (tenant_id, storage_path) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'evil.jpg')$$,
    '42501',
    null,
    'photos: tenant B user cannot insert under tenant A'
);

-- ============================================================================
-- invoices
-- ============================================================================

select test_act_as('11111111-1111-1111-1111-111111111111');
select lives_ok(
    $$insert into public.invoices (tenant_id, status) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'draft')$$,
    'invoices: tenant A user can insert into tenant A'
);
select is(
    (select count(*)::int from public.invoices),
    1,
    'invoices: tenant A user sees their own row'
);

select test_act_as('22222222-2222-2222-2222-222222222222');
select is(
    (select count(*)::int from public.invoices),
    0,
    'invoices: tenant B user sees 0 tenant A rows'
);
select throws_ok(
    $$insert into public.invoices (tenant_id, status) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'draft')$$,
    '42501',
    null,
    'invoices: tenant B user cannot insert under tenant A'
);

-- ============================================================================
-- todos
-- ============================================================================

select test_act_as('11111111-1111-1111-1111-111111111111');
select lives_ok(
    $$insert into public.todos (tenant_id, user_id, title) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Call Smith')$$,
    'todos: tenant A user can insert into tenant A'
);
select is(
    (select count(*)::int from public.todos),
    1,
    'todos: tenant A user sees their own row'
);

select test_act_as('22222222-2222-2222-2222-222222222222');
select is(
    (select count(*)::int from public.todos),
    0,
    'todos: tenant B user sees 0 tenant A rows'
);
select throws_ok(
    $$insert into public.todos (tenant_id, user_id, title) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'Hack')$$,
    '42501',
    null,
    'todos: tenant B user cannot insert under tenant A'
);

-- ============================================================================
-- worklog_entries
-- ============================================================================

select test_act_as('11111111-1111-1111-1111-111111111111');
select lives_ok(
    $$insert into public.worklog_entries (tenant_id, title) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Sent quote')$$,
    'worklog_entries: tenant A user can insert into tenant A'
);
select is(
    (select count(*)::int from public.worklog_entries),
    1,
    'worklog_entries: tenant A user sees their own row'
);

select test_act_as('22222222-2222-2222-2222-222222222222');
select is(
    (select count(*)::int from public.worklog_entries),
    0,
    'worklog_entries: tenant B user sees 0 tenant A rows'
);
select throws_ok(
    $$insert into public.worklog_entries (tenant_id, title) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Evil')$$,
    '42501',
    null,
    'worklog_entries: tenant B user cannot insert under tenant A'
);

-- ============================================================================
-- audit_log
-- ============================================================================

select test_act_as('11111111-1111-1111-1111-111111111111');
select lives_ok(
    $$insert into public.audit_log (tenant_id, action, resource_type) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'create', 'customer')$$,
    'audit_log: tenant A user can insert into tenant A'
);
select is(
    (select count(*)::int from public.audit_log),
    1,
    'audit_log: tenant A user sees their own row'
);

select test_act_as('22222222-2222-2222-2222-222222222222');
select is(
    (select count(*)::int from public.audit_log),
    0,
    'audit_log: tenant B user sees 0 tenant A rows'
);
select throws_ok(
    $$insert into public.audit_log (tenant_id, action, resource_type) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'evil', 'customer')$$,
    '42501',
    null,
    'audit_log: tenant B user cannot insert under tenant A'
);

-- ============================================================================
-- data_exports
-- ============================================================================

select test_act_as('11111111-1111-1111-1111-111111111111');
select lives_ok(
    $$insert into public.data_exports (tenant_id, user_id, status) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'pending')$$,
    'data_exports: tenant A user can insert into tenant A'
);
select is(
    (select count(*)::int from public.data_exports),
    1,
    'data_exports: tenant A user sees their own row'
);

select test_act_as('22222222-2222-2222-2222-222222222222');
select is(
    (select count(*)::int from public.data_exports),
    0,
    'data_exports: tenant B user sees 0 tenant A rows'
);
select throws_ok(
    $$insert into public.data_exports (tenant_id, user_id, status) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'pending')$$,
    '42501',
    null,
    'data_exports: tenant B user cannot insert under tenant A'
);

-- ============================================================================
-- Session-level revocation: removing tenant_members row revokes access
-- on the next query, even in the same session (§13.1).
-- ============================================================================

-- User 1 currently belongs to tenant A. Revoke via service-role (superuser)
-- write to tenant_members, then verify that user 1 can no longer see their
-- tenant-A customers on the next query.
set local role postgres;
delete from public.tenant_members
    where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      and user_id   = '11111111-1111-1111-1111-111111111111';

select test_act_as('11111111-1111-1111-1111-111111111111');
select is(
    (select count(*)::int from public.customers),
    0,
    'current_tenant_id: removed member sees 0 rows in the same session'
);

select * from finish();
rollback;
