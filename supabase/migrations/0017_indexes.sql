-- 0017_indexes.sql
-- FK + hot-query indexes for tables 0005-0015.
--
-- Philosophy:
--   - Every tenant_id gets an index (RLS policies scan by it).
--   - Every FK gets an index (avoid seq scans on join + avoid lock escalation
--     on cascading delete).
--   - Composite indexes on (tenant_id, <hot column>) for common filters. The
--     Postgres planner handles tenant_id-only filters from a prefix of the
--     composite index, so we do not duplicate.

-- === tenant_id indexes ===
CREATE INDEX IF NOT EXISTS customers_tenant_id_idx       ON public.customers       (tenant_id);
CREATE INDEX IF NOT EXISTS service_catalog_tenant_id_idx ON public.service_catalog (tenant_id);
CREATE INDEX IF NOT EXISTS jobs_tenant_id_idx            ON public.jobs            (tenant_id);
CREATE INDEX IF NOT EXISTS photos_tenant_id_idx          ON public.photos          (tenant_id);
CREATE INDEX IF NOT EXISTS invoices_tenant_id_idx        ON public.invoices        (tenant_id);
CREATE INDEX IF NOT EXISTS todos_tenant_id_idx           ON public.todos           (tenant_id);
CREATE INDEX IF NOT EXISTS worklog_entries_tenant_id_idx ON public.worklog_entries (tenant_id);
CREATE INDEX IF NOT EXISTS audit_log_tenant_id_idx       ON public.audit_log       (tenant_id);
CREATE INDEX IF NOT EXISTS data_exports_tenant_id_idx    ON public.data_exports    (tenant_id);
-- quotes: covered by the composite (tenant_id, status) below.

-- === FK indexes ===
CREATE INDEX IF NOT EXISTS quotes_customer_id_idx        ON public.quotes        (customer_id);
CREATE INDEX IF NOT EXISTS quote_surfaces_quote_id_idx   ON public.quote_surfaces (quote_id);
CREATE INDEX IF NOT EXISTS jobs_customer_id_idx          ON public.jobs          (customer_id);
CREATE INDEX IF NOT EXISTS jobs_quote_id_idx             ON public.jobs          (quote_id);
CREATE INDEX IF NOT EXISTS photos_job_id_idx             ON public.photos        (job_id);
CREATE INDEX IF NOT EXISTS invoices_customer_id_idx      ON public.invoices      (customer_id);
CREATE INDEX IF NOT EXISTS invoices_job_id_idx           ON public.invoices      (job_id);
CREATE INDEX IF NOT EXISTS todos_user_id_idx             ON public.todos         (user_id);
CREATE INDEX IF NOT EXISTS worklog_entries_user_id_idx   ON public.worklog_entries (user_id);
CREATE INDEX IF NOT EXISTS audit_log_user_id_idx         ON public.audit_log     (user_id);
CREATE INDEX IF NOT EXISTS data_exports_user_id_idx      ON public.data_exports  (user_id);

-- === composite indexes for hot queries ===
-- (tenant_id, status): dashboard status filters on quotes/jobs/invoices.
CREATE INDEX IF NOT EXISTS quotes_tenant_status_idx   ON public.quotes   (tenant_id, status);
CREATE INDEX IF NOT EXISTS jobs_tenant_status_idx     ON public.jobs     (tenant_id, status);
CREATE INDEX IF NOT EXISTS invoices_tenant_status_idx ON public.invoices (tenant_id, status);

-- (tenant_id, created_at desc): "most recent activity" feed queries.
CREATE INDEX IF NOT EXISTS photos_tenant_created_idx          ON public.photos          (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS worklog_entries_tenant_created_idx ON public.worklog_entries (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_tenant_created_idx       ON public.audit_log       (tenant_id, created_at DESC);

-- (tenant_id, done, due_date): "my open todos, soonest first" list.
CREATE INDEX IF NOT EXISTS todos_tenant_done_due_idx ON public.todos (tenant_id, done, due_date);
