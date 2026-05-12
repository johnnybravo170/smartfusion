-- Customer-facing view modes for projects: lump_sum, sections, categories, detailed.
--
-- The internal budget structure (categories + cost lines) stays as-is — that's
-- how the GC manages the job, logs time, tracks variance. This adds a
-- presentation layer that decides how much of that structure the customer sees:
--
--   lump_sum  → one number + a project summary narrative
--   sections  → customer-facing groupings of multiple internal categories
--   categories → every internal category visible (current portal default-ish)
--   detailed   → every cost line broken out (Jonathan's pressure-washing default)
--
-- This migration is additive — no rendering change ships with it. The customer
-- portal and any future estimate/invoice PDF will read `customer_view_mode` and
-- collapse/expand accordingly in follow-up PRs.
--
-- Description fields (markdown text) are added at every level so the contractor
-- can attach a narrative to whatever they're exposing. Especially important at
-- lump_sum — a single number needs a story.

-- ────────────────────────────────────────────────────────────────────
-- 1. projects: customer_view_mode + customer_summary_md
-- ────────────────────────────────────────────────────────────────────
alter table public.projects
  add column if not exists customer_view_mode text not null default 'detailed'
    check (customer_view_mode in ('lump_sum', 'sections', 'categories', 'detailed')),
  add column if not exists customer_summary_md text;

-- ────────────────────────────────────────────────────────────────────
-- 2. project_customer_sections — optional customer-facing groupings
-- ────────────────────────────────────────────────────────────────────
-- Each project defines its own sections (e.g. "Bathroom Remodel",
-- "Main Floor Reno", "Exterior & Deck"). Categories opt in via
-- `project_budget_categories.customer_section_id`. Sections are only
-- rendered when `projects.customer_view_mode = 'sections'`.

create table if not exists public.project_customer_sections (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  project_id      uuid not null references public.projects(id) on delete cascade,
  name            text not null,
  description_md  text,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_pcs_project on public.project_customer_sections (project_id, sort_order);
create index if not exists idx_pcs_tenant on public.project_customer_sections (tenant_id);

alter table public.project_customer_sections enable row level security;

create policy "tenant_select_pcs" on public.project_customer_sections
  for select to authenticated using (tenant_id = public.current_tenant_id());
create policy "tenant_insert_pcs" on public.project_customer_sections
  for insert to authenticated with check (tenant_id = public.current_tenant_id());
create policy "tenant_update_pcs" on public.project_customer_sections
  for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());
create policy "tenant_delete_pcs" on public.project_customer_sections
  for delete to authenticated using (tenant_id = public.current_tenant_id());

-- ────────────────────────────────────────────────────────────────────
-- 3. project_budget_categories: customer_section_id + description_md
-- ────────────────────────────────────────────────────────────────────
alter table public.project_budget_categories
  add column if not exists customer_section_id uuid
    references public.project_customer_sections(id) on delete set null,
  add column if not exists description_md text;

create index if not exists idx_pbc_customer_section on public.project_budget_categories (customer_section_id);

-- ────────────────────────────────────────────────────────────────────
-- 4. project_cost_lines: description_md
-- ────────────────────────────────────────────────────────────────────
alter table public.project_cost_lines
  add column if not exists description_md text;
