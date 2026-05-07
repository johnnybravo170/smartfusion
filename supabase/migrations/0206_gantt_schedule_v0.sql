-- 0206_gantt_schedule_v0.sql
-- Gantt schedule v0 — schema, seed library, bootstrap-ready data model.
--
-- Adds a per-project Gantt surface that bootstraps from the budget +
-- a project-type template into a draft schedule the customer can see
-- on day one, then sharpens over time as the GC pins real dates and
-- durations (rough → firm). Mirrors to the customer portal as a
-- read-only timeline with disruption signals.
--
-- This migration lands the foundation only — schema, RLS, seed library,
-- and the budget→trade FK that the bootstrap algorithm uses. Bootstrap
-- algorithm, server actions, and operator/portal UI are follow-up PRs.
--
-- Tables created here:
--   trade_templates                  — global lookup (~30 standard trades)
--   project_type_templates           — global lookup (kitchen reno, bath reno, …)
--   project_type_template_trades     — join: which trades each template includes
--   project_schedule_tasks           — per-project Gantt rows (tenant-scoped)
--
-- Project_phases is unchanged — phases stay as the coarse customer-facing
-- milestone rail. Tasks are the finer Gantt detail and optionally roll up
-- to a phase via project_schedule_tasks.phase_id.

-- ---------------------------------------------------------------------------
-- 1. trade_templates — global library of standard trades
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.trade_templates (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  slug                     TEXT NOT NULL UNIQUE,
  name                     TEXT NOT NULL,
  description              TEXT,

  -- Typical span in days. GC overrides per task; this is just the seed.
  default_duration_days    INTEGER NOT NULL CHECK (default_duration_days > 0),

  -- Canonical sequence position (0–100). Determines bootstrap ordering.
  -- Demo ≈ 10, framing ≈ 20, rough-ins ≈ 35, drywall ≈ 50, finishes ≈ 70+.
  sequence_position        INTEGER NOT NULL CHECK (sequence_position BETWEEN 0 AND 100),

  -- Drives the customer-portal warning ("plan to be out — drywall dust").
  disruption_level         TEXT NOT NULL DEFAULT 'low'
    CHECK (disruption_level IN ('none', 'low', 'medium', 'high')),

  -- Which project_phases name this trade typically rolls up to. Free-text
  -- match (project_phases is per-project, not a global lookup) — code does
  -- the match in the bootstrap algorithm.
  typical_phase            TEXT,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trade_templates_sequence
  ON public.trade_templates (sequence_position);

ALTER TABLE public.trade_templates ENABLE ROW LEVEL SECURITY;

-- Global lookup table: any authenticated user reads. Writes are admin-only
-- via service role (no INSERT/UPDATE/DELETE policies = blocked for
-- authenticated, allowed for service_role).
CREATE POLICY trade_templates_read ON public.trade_templates
  FOR SELECT TO authenticated
  USING (true);

COMMENT ON TABLE public.trade_templates IS
  'Global library of standard residential reno trades. Seeded once; read by the Gantt bootstrap algorithm to lay out a draft schedule from a project''s budget categories. Disruption_level drives the customer-portal warning under high-disruption days.';

-- ---------------------------------------------------------------------------
-- 2. project_type_templates — global library of project archetypes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.project_type_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.project_type_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY project_type_templates_read ON public.project_type_templates
  FOR SELECT TO authenticated
  USING (true);

COMMENT ON TABLE public.project_type_templates IS
  'Global library of project archetypes (Kitchen Reno, Bath Reno, Basement Finish, Addition). Bundles a subset of trade_templates with optional duration / sequence overrides to give the bootstrap algorithm a starting point.';

-- ---------------------------------------------------------------------------
-- 3. project_type_template_trades — join with optional overrides
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.project_type_template_trades (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  project_type_template_id    UUID NOT NULL REFERENCES public.project_type_templates (id) ON DELETE CASCADE,
  trade_template_id           UUID NOT NULL REFERENCES public.trade_templates (id) ON DELETE CASCADE,

  -- NULL means "use the trade's default". Per-template tweaks live here.
  duration_override_days      INTEGER CHECK (duration_override_days IS NULL OR duration_override_days > 0),
  sequence_override           INTEGER CHECK (sequence_override IS NULL OR sequence_override BETWEEN 0 AND 100),

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (project_type_template_id, trade_template_id)
);

CREATE INDEX IF NOT EXISTS idx_pttt_template
  ON public.project_type_template_trades (project_type_template_id);

ALTER TABLE public.project_type_template_trades ENABLE ROW LEVEL SECURITY;

CREATE POLICY pttt_read ON public.project_type_template_trades
  FOR SELECT TO authenticated
  USING (true);

COMMENT ON TABLE public.project_type_template_trades IS
  'Which trades each project_type_template includes, with optional per-template overrides. Used by the bootstrap algorithm when GC picks "Apply Kitchen Reno template" on an empty schedule.';

-- ---------------------------------------------------------------------------
-- 4. project_budget_categories.trade_template_id — explicit FK for bootstrap
-- ---------------------------------------------------------------------------
-- Adds a nullable FK so a budget category can declare which trade it
-- represents. The bootstrap algorithm uses this when GC picks "Bootstrap
-- from budget". Backfilled below by name match; new categories created
-- later through the budget UI should set this when possible.

ALTER TABLE public.project_budget_categories
  ADD COLUMN IF NOT EXISTS trade_template_id UUID REFERENCES public.trade_templates (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_project_budget_categories_trade
  ON public.project_budget_categories (trade_template_id)
  WHERE trade_template_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. project_schedule_tasks — per-project Gantt rows (tenant-scoped)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.project_schedule_tasks (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  tenant_id                UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  project_id               UUID NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,

  name                     TEXT NOT NULL,

  -- Optional links back to the source data the task was bootstrapped from.
  -- Lets the UI explain "this task came from your budget's Drywall line".
  trade_template_id        UUID REFERENCES public.trade_templates (id) ON DELETE SET NULL,
  budget_category_id       UUID REFERENCES public.project_budget_categories (id) ON DELETE SET NULL,

  -- Optional rollup to a project_phase. Tasks that don't map to a phase
  -- (one-offs, contingency) just leave this null.
  phase_id                 UUID REFERENCES public.project_phases (id) ON DELETE SET NULL,

  planned_start_date       DATE NOT NULL,
  planned_duration_days    INTEGER NOT NULL CHECK (planned_duration_days > 0),

  actual_start_date        DATE,
  actual_end_date          DATE,

  status                   TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'scheduled', 'in_progress', 'done')),

  -- 'rough' = bootstrapped guess, dashed/muted in the UI.
  -- 'firm'  = GC has confirmed the date, solid in the UI.
  confidence               TEXT NOT NULL DEFAULT 'rough'
    CHECK (confidence IN ('rough', 'firm')),

  client_visible           BOOLEAN NOT NULL DEFAULT TRUE,
  display_order            INTEGER NOT NULL DEFAULT 0,

  notes                    TEXT,

  -- Soft-delete (per spec answer #5): customers may ask "wasn't tile
  -- supposed to start last week?" — keeping the row preserves audit.
  deleted_at               TIMESTAMPTZ,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_schedule_tasks_project
  ON public.project_schedule_tasks (project_id, planned_start_date)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_project_schedule_tasks_tenant
  ON public.project_schedule_tasks (tenant_id);

CREATE INDEX IF NOT EXISTS idx_project_schedule_tasks_phase
  ON public.project_schedule_tasks (phase_id)
  WHERE phase_id IS NOT NULL;

-- Auto-stamp tenant_id on insert from the linked project. Mirrors the
-- "tenant_id derived from project" invariant; eliminates a class of
-- application bugs where server actions forget to set tenant_id and
-- end up with NULL or — worse — a wrong tenant.
CREATE OR REPLACE FUNCTION public.stamp_project_schedule_tasks_tenant_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.tenant_id IS NULL THEN
    SELECT tenant_id INTO NEW.tenant_id
    FROM public.projects
    WHERE id = NEW.project_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_project_schedule_tasks_stamp_tenant
  ON public.project_schedule_tasks;
CREATE TRIGGER trg_project_schedule_tasks_stamp_tenant
  BEFORE INSERT ON public.project_schedule_tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_project_schedule_tasks_tenant_id();

ALTER TABLE public.project_schedule_tasks ENABLE ROW LEVEL SECURITY;

-- Same shape as project_phases: full CRUD for owner/admin/member of the
-- task's tenant. Workers fall through. Public portal route uses the
-- service-role admin client and bypasses these policies.
CREATE POLICY project_schedule_tasks_tenant_all ON public.project_schedule_tasks
  FOR ALL TO authenticated
  USING (
    tenant_id = public.current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.tenant_members tm
      WHERE tm.user_id = auth.uid()
        AND tm.tenant_id = public.project_schedule_tasks.tenant_id
        AND tm.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    tenant_id = public.current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.tenant_members tm
      WHERE tm.user_id = auth.uid()
        AND tm.tenant_id = public.project_schedule_tasks.tenant_id
        AND tm.role IN ('owner', 'admin', 'member')
    )
  );

COMMENT ON TABLE public.project_schedule_tasks IS
  'Per-project Gantt rows. Bootstrapped from the budget + a project-type template into a draft schedule (confidence=rough), then sharpened over time by the GC (confidence=firm). Soft-deleted via deleted_at. Customer portal renders rows where client_visible=true and deleted_at IS NULL.';

-- ---------------------------------------------------------------------------
-- 6. Seed: trade_templates
-- ---------------------------------------------------------------------------
-- Slug list aligns with the chart-of-accounts categories Henry's GCs
-- already use (see src/server/actions/project-memos.ts standard list)
-- plus a handful of additions needed for sensible Gantt sequencing
-- (site_prep, excavation, foundation, roofing, tile, punch_list,
-- final_inspection). Sequence positions are spaced for inserts later.

INSERT INTO public.trade_templates
  (slug, name, default_duration_days, sequence_position, disruption_level, typical_phase, description)
VALUES
  ('site_prep',          'Site prep',          1,  5,  'low',    'Demo',                'Protect floors, set up dust barriers, stage materials.'),
  ('demo',               'Demo',               3,  10, 'high',   'Demo',                'Demolition. Loud, dusty, often water-off briefly.'),
  ('disposal',           'Disposal',           1,  12, 'low',    'Demo',                'Bin haul-out, dump runs.'),
  ('excavation',         'Excavation',         3,  15, 'low',    'Demo',                'Dig for footings or basement extension.'),
  ('foundation',         'Foundation',         5,  18, 'low',    'Demo',                'Forms, pour, cure.'),
  ('framing',            'Framing',            5,  20, 'medium', 'Framing',             'Walls, floor systems, ceiling joists.'),
  ('roofing',            'Roofing',            3,  25, 'medium', 'Framing',             'Shingles, membrane, flashing.'),
  ('sheathing',          'Sheathing',          2,  28, 'low',    'Framing',             'Exterior wall sheathing.'),
  ('windows_doors',      'Windows & Doors',    2,  30, 'low',    'Framing',             'Window and exterior door installs.'),
  ('siding',             'Siding',             4,  32, 'low',    'Framing',             'Exterior cladding.'),
  ('rot_repair',         'Rot Repair',         2,  33, 'low',    'Framing',             'Replace rotted framing or sheathing as found.'),
  ('plumbing',           'Plumbing',           3,  35, 'medium', 'Rough-in',            'Plumbing rough-in. Water off intermittently.'),
  ('electrical',         'Electrical',         3,  38, 'medium', 'Rough-in',            'Electrical rough-in. Power off intermittently.'),
  ('hvac',               'HVAC',               3,  40, 'medium', 'Rough-in',            'Heating and cooling rough-in.'),
  ('insulation',         'Insulation',         2,  45, 'low',    'Rough-in',            'Wall and ceiling insulation.'),
  ('drywall',            'Drywall',            5,  50, 'high',   'Drywall',             'Hang, tape, mud, sand. Heavy dust during sanding.'),
  ('painting',           'Painting',           3,  60, 'high',   'Finishes',            'Primer + finish coats. Fumes; ventilate.'),
  ('tile',               'Tile',               3,  65, 'high',   'Finishes',            'Tile prep, set, grout. Saw cuts are loud and dusty.'),
  ('flooring',           'Flooring',           3,  70, 'high',   'Finishes',            'Hardwood, LVP, or carpet. Disruptive in occupied areas.'),
  ('kitchen',            'Kitchen',            4,  75, 'low',    'Cabinets & fixtures', 'Cabinet install + countertop template/install.'),
  ('plumbing_fixtures',  'Plumbing Fixtures',  2,  78, 'high',   'Cabinets & fixtures', 'Toilets, faucets, hookups. Water off during install.'),
  ('doors_mouldings',    'Doors & Mouldings',  3,  80, 'low',    'Finishes',            'Interior doors, baseboards, casings.'),
  ('railings',           'Railings',           1,  82, 'low',    'Finishes',            'Stair and balcony railings.'),
  ('gutters',            'Gutters',            1,  90, 'low',    'Finishes',            'Eavestroughs and downspouts.'),
  ('front_door',         'Front Door',         1,  92, 'none',   'Finishes',            'Front door swap or refinish.'),
  ('front_garden',       'Front Garden',       1,  93, 'none',   'Finishes',            'Curb-appeal landscaping.'),
  ('garage_doors',       'Garage Doors',       1,  94, 'none',   'Finishes',            'Garage door install or service.'),
  ('punch_list',         'Punch list',         3,  95, 'low',    'Punch list',          'Final touch-ups, deficiencies, missed items.'),
  ('final_inspection',   'Final inspection',   1,  98, 'none',   'Final walkthrough',   'Municipal final inspection + customer walkthrough.'),
  ('contingency',        'Contingency',        1,  99, 'none',   NULL,                  'Reserve buffer for unknowns. Typically not scheduled.')
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 7. Seed: project_type_templates
-- ---------------------------------------------------------------------------

INSERT INTO public.project_type_templates (slug, name, description) VALUES
  ('kitchen_reno',     'Kitchen Reno',     'Tear-out + rebuild of an existing kitchen. Includes plumbing/electrical adjustments, drywall patching, tile, cabinets, fixtures, paint.'),
  ('bath_reno',        'Bath Reno',        'Bathroom refresh: tear out, plumbing rework, tile, fixtures, paint.'),
  ('basement_finish',  'Basement Finish',  'Frame out + finish an unfinished basement: framing, rough-ins, insulation, drywall, flooring, paint, doors.'),
  ('addition',         'Addition',         'New square footage: site prep, excavation, foundation, framing, roof, full rough-ins, drywall, finishes, inspection.')
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 8. Seed: project_type_template_trades (joins, no overrides for v0)
-- ---------------------------------------------------------------------------
-- Each row inserts (template_slug, trade_slug). Bootstrap algorithm reads
-- trade_templates.default_duration_days + .sequence_position; overrides
-- left null for v0.

WITH wanted (template_slug, trade_slug) AS (VALUES
  -- Kitchen Reno
  ('kitchen_reno', 'demo'),
  ('kitchen_reno', 'disposal'),
  ('kitchen_reno', 'plumbing'),
  ('kitchen_reno', 'electrical'),
  ('kitchen_reno', 'hvac'),
  ('kitchen_reno', 'drywall'),
  ('kitchen_reno', 'painting'),
  ('kitchen_reno', 'tile'),
  ('kitchen_reno', 'flooring'),
  ('kitchen_reno', 'kitchen'),
  ('kitchen_reno', 'plumbing_fixtures'),
  ('kitchen_reno', 'doors_mouldings'),
  ('kitchen_reno', 'punch_list'),

  -- Bath Reno
  ('bath_reno', 'demo'),
  ('bath_reno', 'disposal'),
  ('bath_reno', 'plumbing'),
  ('bath_reno', 'electrical'),
  ('bath_reno', 'drywall'),
  ('bath_reno', 'painting'),
  ('bath_reno', 'tile'),
  ('bath_reno', 'plumbing_fixtures'),
  ('bath_reno', 'doors_mouldings'),
  ('bath_reno', 'punch_list'),

  -- Basement Finish
  ('basement_finish', 'site_prep'),
  ('basement_finish', 'framing'),
  ('basement_finish', 'plumbing'),
  ('basement_finish', 'electrical'),
  ('basement_finish', 'hvac'),
  ('basement_finish', 'insulation'),
  ('basement_finish', 'drywall'),
  ('basement_finish', 'painting'),
  ('basement_finish', 'flooring'),
  ('basement_finish', 'doors_mouldings'),
  ('basement_finish', 'railings'),
  ('basement_finish', 'punch_list'),

  -- Addition
  ('addition', 'site_prep'),
  ('addition', 'excavation'),
  ('addition', 'foundation'),
  ('addition', 'framing'),
  ('addition', 'roofing'),
  ('addition', 'sheathing'),
  ('addition', 'windows_doors'),
  ('addition', 'plumbing'),
  ('addition', 'electrical'),
  ('addition', 'hvac'),
  ('addition', 'insulation'),
  ('addition', 'drywall'),
  ('addition', 'painting'),
  ('addition', 'flooring'),
  ('addition', 'doors_mouldings'),
  ('addition', 'punch_list'),
  ('addition', 'final_inspection')
)
INSERT INTO public.project_type_template_trades (project_type_template_id, trade_template_id)
SELECT pt.id, tr.id
FROM wanted w
JOIN public.project_type_templates pt ON pt.slug = w.template_slug
JOIN public.trade_templates       tr ON tr.slug = w.trade_slug
ON CONFLICT (project_type_template_id, trade_template_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 9. Backfill: project_budget_categories.trade_template_id by name match
-- ---------------------------------------------------------------------------
-- Best-effort name match between existing budget category names and the
-- new trade_templates library. Case-insensitive on the trimmed name.
-- Categories that don't match (custom names, typos, multi-trade buckets)
-- stay null and the GC can map them in v1 / via a follow-up admin UI.

UPDATE public.project_budget_categories pbc
SET trade_template_id = tr.id
FROM public.trade_templates tr
WHERE pbc.trade_template_id IS NULL
  AND LOWER(TRIM(pbc.name)) = LOWER(tr.name);
