-- 0045_quote_line_items.sql
-- Adds quote_line_items: canonical pricing output for all verticals.
-- quote_surfaces stays as the polygon-input audit record for pressure washing.
-- line_item_id on quote_surfaces links each polygon back to its canonical line item.

-- 1. Create quote_line_items
CREATE TABLE quote_line_items (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id         UUID        NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  label            TEXT        NOT NULL,
  qty              NUMERIC(12,2) NOT NULL DEFAULT 1,
  unit             TEXT        NOT NULL DEFAULT 'item',
  unit_price_cents INTEGER     NOT NULL DEFAULT 0,
  line_total_cents INTEGER     NOT NULL DEFAULT 0,
  sort_order       INTEGER     NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Link quote_surfaces back to their canonical line item (optional, SET NULL on delete)
ALTER TABLE quote_surfaces
  ADD COLUMN line_item_id UUID REFERENCES quote_line_items(id) ON DELETE SET NULL;

-- 3. RLS — tenant isolation via quote_id FK (same pattern as quote_surfaces)
ALTER TABLE quote_line_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON quote_line_items
  USING (
    quote_id IN (
      SELECT id FROM quotes WHERE tenant_id = current_tenant_id()
    )
  );

-- 4. Backfill: one line_item per existing quote_surface
DO $$
DECLARE
  s          RECORD;
  new_li_id  UUID;
  lbl        TEXT;
  qty_val    NUMERIC;
  unit_val   TEXT;
  unit_price INTEGER;
BEGIN
  FOR s IN
    SELECT
      qs.id,
      qs.quote_id,
      qs.surface_type,
      qs.sqft,
      qs.price_cents,
      (ROW_NUMBER() OVER (PARTITION BY qs.quote_id ORDER BY qs.created_at) - 1)::INTEGER AS rn
    FROM quote_surfaces qs
    ORDER BY qs.quote_id, qs.created_at
  LOOP
    lbl := INITCAP(REPLACE(s.surface_type, '_', ' '));

    IF s.sqft IS NOT NULL AND s.sqft > 0 THEN
      qty_val    := s.sqft;
      unit_val   := 'sq ft';
      unit_price := ROUND(s.price_cents::NUMERIC / s.sqft);
    ELSE
      qty_val    := 1;
      unit_val   := 'item';
      unit_price := s.price_cents;
    END IF;

    INSERT INTO quote_line_items
      (quote_id, label, qty, unit, unit_price_cents, line_total_cents, sort_order)
    VALUES
      (s.quote_id, lbl, qty_val, unit_val, unit_price, s.price_cents, s.rn)
    RETURNING id INTO new_li_id;

    UPDATE quote_surfaces SET line_item_id = new_li_id WHERE id = s.id;
  END LOOP;
END;
$$;

-- 5. Index for common reads
CREATE INDEX ON quote_line_items (quote_id);
