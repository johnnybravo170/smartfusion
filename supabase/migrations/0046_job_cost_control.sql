-- 0046_job_cost_control.sql
-- Job Cost Control module for the GC vertical.
-- Six new tables: materials_catalog, labour_rates, project_cost_lines,
-- purchase_orders, purchase_order_items, project_bills.

-- ─────────────────────────────────────────────
-- 1. materials_catalog
-- ─────────────────────────────────────────────
CREATE TABLE materials_catalog (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category         TEXT         NOT NULL DEFAULT 'material'
                                CHECK (category IN ('material','labour','sub','equipment','overhead')),
  cost_code        TEXT,
  label            TEXT         NOT NULL,
  description      TEXT,
  unit             TEXT         NOT NULL DEFAULT 'item',
  unit_cost_cents  INTEGER      NOT NULL DEFAULT 0,
  unit_price_cents INTEGER      NOT NULL DEFAULT 0,
  markup_pct       NUMERIC(5,2) NOT NULL DEFAULT 0,
  vendor           TEXT,
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE materials_catalog ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON materials_catalog
  USING (tenant_id = current_tenant_id());

CREATE INDEX ON materials_catalog (tenant_id, is_active);

-- ─────────────────────────────────────────────
-- 2. labour_rates
-- ─────────────────────────────────────────────
CREATE TABLE labour_rates (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  trade               TEXT        NOT NULL,
  role                TEXT        NOT NULL DEFAULT 'lead',
  cost_per_hour_cents INTEGER     NOT NULL DEFAULT 0,
  bill_per_hour_cents INTEGER     NOT NULL DEFAULT 0,
  is_active           BOOLEAN     NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE labour_rates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON labour_rates
  USING (tenant_id = current_tenant_id());

CREATE INDEX ON labour_rates (tenant_id, is_active);

-- ─────────────────────────────────────────────
-- 3. project_cost_lines  (line items on a project estimate)
-- ─────────────────────────────────────────────
CREATE TABLE project_cost_lines (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID         NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  bucket_id        UUID         REFERENCES project_cost_buckets(id) ON DELETE SET NULL,
  catalog_item_id  UUID         REFERENCES materials_catalog(id) ON DELETE SET NULL,
  category         TEXT         NOT NULL DEFAULT 'material'
                                CHECK (category IN ('material','labour','sub','equipment','overhead')),
  label            TEXT         NOT NULL,
  qty              NUMERIC(12,2) NOT NULL DEFAULT 1,
  unit             TEXT         NOT NULL DEFAULT 'item',
  unit_cost_cents  INTEGER      NOT NULL DEFAULT 0,
  unit_price_cents INTEGER      NOT NULL DEFAULT 0,
  markup_pct       NUMERIC(5,2) NOT NULL DEFAULT 0,
  line_cost_cents  INTEGER      NOT NULL DEFAULT 0,
  line_price_cents INTEGER      NOT NULL DEFAULT 0,
  sort_order       INTEGER      NOT NULL DEFAULT 0,
  notes            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE project_cost_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON project_cost_lines
  USING (
    project_id IN (
      SELECT id FROM projects WHERE tenant_id = current_tenant_id()
    )
  );

CREATE INDEX ON project_cost_lines (project_id, sort_order);

-- ─────────────────────────────────────────────
-- 4. purchase_orders
-- ─────────────────────────────────────────────
CREATE TABLE purchase_orders (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id    UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  vendor        TEXT        NOT NULL,
  po_number     TEXT,
  status        TEXT        NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','sent','acknowledged','received','closed')),
  issued_date   DATE,
  expected_date DATE,
  notes         TEXT,
  total_cents   INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON purchase_orders
  USING (tenant_id = current_tenant_id());

CREATE INDEX ON purchase_orders (project_id);

-- ─────────────────────────────────────────────
-- 5. purchase_order_items
-- ─────────────────────────────────────────────
CREATE TABLE purchase_order_items (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id            UUID         NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  cost_line_id     UUID         REFERENCES project_cost_lines(id) ON DELETE SET NULL,
  label            TEXT         NOT NULL,
  qty              NUMERIC(12,2) NOT NULL DEFAULT 1,
  unit             TEXT         NOT NULL DEFAULT 'item',
  unit_cost_cents  INTEGER      NOT NULL DEFAULT 0,
  line_total_cents INTEGER      NOT NULL DEFAULT 0,
  received_qty     NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON purchase_order_items
  USING (
    po_id IN (
      SELECT id FROM purchase_orders WHERE tenant_id = current_tenant_id()
    )
  );

CREATE INDEX ON purchase_order_items (po_id);

-- ─────────────────────────────────────────────
-- 6. project_bills  (sub invoices / direct costs)
-- ─────────────────────────────────────────────
CREATE TABLE project_bills (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id   UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  vendor       TEXT        NOT NULL,
  bill_date    DATE        NOT NULL,
  description  TEXT,
  amount_cents INTEGER     NOT NULL DEFAULT 0,
  status       TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','approved','paid')),
  receipt_url  TEXT,
  cost_code    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE project_bills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON project_bills
  USING (tenant_id = current_tenant_id());

CREATE INDEX ON project_bills (project_id);
