-- 0145_vertical_profile_packs.sql
-- Data-driven vertical profile system. See knowledge_doc 8f1c898d-... for the
-- full architectural rationale; this migration ships V1 of the table plus
-- the additive columns we'll need for multi-trade tenants.
--
-- V1 scope of `config` JSONB: nav_items + display_name. Everything else
-- (terminology, default pipeline stages, dashboard widgets, automations,
-- Henry voice block) gets added as new keys in later migrations as those
-- subsystems migrate off their hardcoded TS branches.

CREATE TABLE IF NOT EXISTS public.vertical_profile_packs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vertical TEXT NOT NULL UNIQUE,
  parent_vertical TEXT REFERENCES public.vertical_profile_packs (vertical) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vertical_profile_packs_active_idx
  ON public.vertical_profile_packs (active) WHERE active = true;

ALTER TABLE public.vertical_profile_packs ENABLE ROW LEVEL SECURITY;

-- SELECT-only for authenticated; the table is platform-wide config, not
-- tenant-scoped. Writes go through service-role admin (or future platform
-- admin UI).
CREATE POLICY vertical_profile_packs_select_all
  ON public.vertical_profile_packs
  FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================
-- Multi-trade additive columns
-- ============================================================
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS secondary_verticals TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS vertical_context TEXT;
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS vertical_context TEXT;

COMMENT ON COLUMN public.tenants.secondary_verticals IS
  'Additional verticals this tenant operates in (e.g. PW + window cleaning). Primary stays in tenants.vertical.';
COMMENT ON COLUMN public.projects.vertical_context IS
  'Per-project vertical override. NULL = inherit tenants.vertical. Used for multi-trade contractors.';
COMMENT ON COLUMN public.jobs.vertical_context IS
  'Per-job vertical override. NULL = inherit tenants.vertical. Used for multi-trade contractors.';

-- ============================================================
-- Seed the four packs that exist today
-- ============================================================
INSERT INTO public.vertical_profile_packs (vertical, display_name, config) VALUES
  ('pressure_washing', 'Pressure Washing', $${
    "nav_items": [
      { "href": "/dashboard", "label": "Dashboard", "icon": "LayoutDashboard" },
      { "href": "/contacts", "label": "Contacts", "icon": "Users" },
      { "href": "/quotes", "label": "Quotes", "icon": "FileText" },
      { "href": "/jobs", "label": "Jobs", "icon": "ClipboardList" },
      { "href": "/invoices", "label": "Invoices", "icon": "Receipt" },
      { "href": "/inbox", "label": "Inbox", "icon": "Inbox" },
      { "href": "/settings/team", "label": "Team", "icon": "UserCog" },
      { "href": "/referrals", "label": "Refer & Earn", "icon": "Gift" },
      { "href": "/settings", "label": "Settings", "icon": "Settings" }
    ]
  }$$::jsonb),
  ('renovation', 'Renovation GC', $${
    "nav_items": [
      { "href": "/dashboard", "label": "Dashboard", "icon": "LayoutDashboard" },
      { "href": "/contacts", "label": "Contacts", "icon": "Users" },
      { "href": "/projects", "label": "Projects", "icon": "FolderKanban" },
      { "href": "/calendar", "label": "Calendar", "icon": "CalendarDays" },
      { "href": "/jobs", "label": "Jobs", "icon": "ClipboardList" },
      { "href": "/invoices", "label": "Invoices", "icon": "Receipt" },
      { "href": "/expenses", "label": "Expenses", "icon": "Wallet" },
      { "href": "/inbox", "label": "Inbox", "icon": "Inbox" },
      { "href": "/settings/team", "label": "Team", "icon": "UserCog" },
      { "href": "/referrals", "label": "Refer & Earn", "icon": "Gift" },
      { "href": "/settings", "label": "Settings", "icon": "Settings" }
    ]
  }$$::jsonb),
  ('tile', 'Tile & Finishing', $${
    "nav_items": [
      { "href": "/dashboard", "label": "Dashboard", "icon": "LayoutDashboard" },
      { "href": "/contacts", "label": "Contacts", "icon": "Users" },
      { "href": "/projects", "label": "Projects", "icon": "FolderKanban" },
      { "href": "/calendar", "label": "Calendar", "icon": "CalendarDays" },
      { "href": "/jobs", "label": "Jobs", "icon": "ClipboardList" },
      { "href": "/invoices", "label": "Invoices", "icon": "Receipt" },
      { "href": "/expenses", "label": "Expenses", "icon": "Wallet" },
      { "href": "/inbox", "label": "Inbox", "icon": "Inbox" },
      { "href": "/settings/team", "label": "Team", "icon": "UserCog" },
      { "href": "/referrals", "label": "Refer & Earn", "icon": "Gift" },
      { "href": "/settings", "label": "Settings", "icon": "Settings" }
    ]
  }$$::jsonb),
  ('personal', 'Personal', $${
    "nav_items": [
      { "href": "/dashboard", "label": "Dashboard", "icon": "LayoutDashboard" },
      { "href": "/contacts", "label": "Contacts", "icon": "Users" },
      { "href": "/inbox", "label": "Inbox", "icon": "Inbox" },
      { "href": "/expenses", "label": "Expenses", "icon": "Wallet" },
      { "href": "/settings", "label": "Settings", "icon": "Settings" }
    ]
  }$$::jsonb)
ON CONFLICT (vertical) DO NOTHING;

COMMENT ON TABLE public.vertical_profile_packs IS
  'Per-vertical config bundle (nav, terminology, defaults). One row per vertical. Adding a vertical = INSERT, not deploy.';
