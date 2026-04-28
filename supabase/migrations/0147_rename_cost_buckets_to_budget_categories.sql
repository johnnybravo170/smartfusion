-- 0147_rename_cost_buckets_to_budget_categories
--
-- Project cost buckets → project budget categories. The "buckets"
-- terminology was a leftover internal name; the operator-facing tab is
-- "Budget" and the column header is "Category". Aligning code/DB with
-- UI vocabulary so the next dev (or AI agent) doesn't have to mentally
-- translate between them.
--
-- Pure rename — no row data touched. Renames the table, FK columns on
-- dependent tables, indexes, RLS policies, and FK constraint names.

BEGIN;

-- Table
ALTER TABLE public.project_cost_buckets RENAME TO project_budget_categories;

-- FK columns on dependent tables: bucket_id → budget_category_id
ALTER TABLE public.expenses                       RENAME COLUMN bucket_id TO budget_category_id;
ALTER TABLE public.project_bills                  RENAME COLUMN bucket_id TO budget_category_id;
ALTER TABLE public.project_cost_lines             RENAME COLUMN bucket_id TO budget_category_id;
ALTER TABLE public.project_sub_quote_allocations  RENAME COLUMN bucket_id TO budget_category_id;
ALTER TABLE public.time_entries                   RENAME COLUMN bucket_id TO budget_category_id;

-- Indexes
ALTER INDEX public.idx_project_cost_buckets_project RENAME TO idx_project_budget_categories_project;
ALTER INDEX public.idx_project_cost_buckets_tenant  RENAME TO idx_project_budget_categories_tenant;
ALTER INDEX public.project_cost_buckets_pkey        RENAME TO project_budget_categories_pkey;

-- RLS policies
ALTER POLICY tenant_select_project_cost_buckets ON public.project_budget_categories
  RENAME TO tenant_select_project_budget_categories;
ALTER POLICY tenant_insert_project_cost_buckets ON public.project_budget_categories
  RENAME TO tenant_insert_project_budget_categories;
ALTER POLICY tenant_update_project_cost_buckets ON public.project_budget_categories
  RENAME TO tenant_update_project_budget_categories;
ALTER POLICY tenant_delete_project_cost_buckets ON public.project_budget_categories
  RENAME TO tenant_delete_project_budget_categories;

-- FK constraint names — purely cosmetic but matches new column names
ALTER TABLE public.expenses
  RENAME CONSTRAINT expenses_bucket_id_fkey TO expenses_budget_category_id_fkey;
ALTER TABLE public.project_bills
  RENAME CONSTRAINT project_bills_bucket_id_fkey TO project_bills_budget_category_id_fkey;
ALTER TABLE public.project_cost_lines
  RENAME CONSTRAINT project_cost_lines_bucket_id_fkey TO project_cost_lines_budget_category_id_fkey;
ALTER TABLE public.project_sub_quote_allocations
  RENAME CONSTRAINT project_sub_quote_allocations_bucket_id_fkey TO project_sub_quote_allocations_budget_category_id_fkey;
ALTER TABLE public.time_entries
  RENAME CONSTRAINT time_entries_bucket_id_fkey TO time_entries_budget_category_id_fkey;

-- ----- cost_bucket_templates → budget_category_templates ----------------
-- Templates of category sets applied when creating a new renovation
-- project. Same UI vocabulary alignment as the main table.
ALTER TABLE public.cost_bucket_templates RENAME TO budget_category_templates;
-- Column `buckets` (jsonb array of category names) → `categories`
ALTER TABLE public.budget_category_templates RENAME COLUMN buckets TO categories;

ALTER INDEX public.idx_cost_bucket_templates_tenant
  RENAME TO idx_budget_category_templates_tenant;

ALTER POLICY tenant_select_cost_bucket_templates ON public.budget_category_templates
  RENAME TO tenant_select_budget_category_templates;
ALTER POLICY tenant_insert_cost_bucket_templates ON public.budget_category_templates
  RENAME TO tenant_insert_budget_category_templates;
ALTER POLICY tenant_update_cost_bucket_templates ON public.budget_category_templates
  RENAME TO tenant_update_budget_category_templates;
ALTER POLICY tenant_delete_cost_bucket_templates ON public.budget_category_templates
  RENAME TO tenant_delete_budget_category_templates;

COMMIT;
