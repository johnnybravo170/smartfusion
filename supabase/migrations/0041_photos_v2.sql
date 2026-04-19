-- 0041_photos_v2.sql
-- Photo system v2 — schema for intelligence.
--
-- Phase 1 of PHOTOS_PLAN.md. Adds every field Henry needs to reason about
-- photos (GPS, device, dimensions, AI classifications + confidence), plus
-- first-class tables for albums, before/after pairs, and share links.
-- Also adds a general tenant_prefs table for correction learning across
-- every module (photos, email voice, social, etc.) — not photo-specific.
--
-- No UI changes in Phase 1. Existing capture paths keep working because
-- all new photo columns are nullable.

-- ---------------------------------------------------------------------------
-- Extend `tag` vocabulary + add v2 columns to `photos`.
-- ---------------------------------------------------------------------------

ALTER TABLE public.photos DROP CONSTRAINT IF EXISTS photos_tag_check;
ALTER TABLE public.photos ADD CONSTRAINT photos_tag_check
  CHECK (tag IN ('before', 'after', 'progress', 'damage', 'materials', 'equipment', 'serial', 'other'));

ALTER TABLE public.photos
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS uploader_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'web'
    CHECK (source IN ('web', 'mobile_pwa', 'native', 'client', 'import')),
  ADD COLUMN IF NOT EXISTS device JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS gps_lat NUMERIC(10, 7),
  ADD COLUMN IF NOT EXISTS gps_lng NUMERIC(10, 7),
  ADD COLUMN IF NOT EXISTS gps_accuracy_m NUMERIC(8, 2),
  ADD COLUMN IF NOT EXISTS width INTEGER,
  ADD COLUMN IF NOT EXISTS height INTEGER,
  ADD COLUMN IF NOT EXISTS bytes INTEGER,
  ADD COLUMN IF NOT EXISTS mime TEXT,
  ADD COLUMN IF NOT EXISTS dominant_color TEXT, -- hex, for gallery UI

  -- AI layer (populated by Phase 2 worker, nullable until then)
  ADD COLUMN IF NOT EXISTS ai_tag TEXT
    CHECK (ai_tag IS NULL OR ai_tag IN ('before', 'after', 'progress', 'damage', 'materials', 'equipment', 'serial', 'other')),
  ADD COLUMN IF NOT EXISTS ai_tag_confidence NUMERIC(4, 3) CHECK (ai_tag_confidence IS NULL OR (ai_tag_confidence >= 0 AND ai_tag_confidence <= 1)),
  ADD COLUMN IF NOT EXISTS ai_caption TEXT,
  ADD COLUMN IF NOT EXISTS ai_caption_confidence NUMERIC(4, 3) CHECK (ai_caption_confidence IS NULL OR (ai_caption_confidence >= 0 AND ai_caption_confidence <= 1)),
  ADD COLUMN IF NOT EXISTS caption_source TEXT NOT NULL DEFAULT 'user'
    CHECK (caption_source IN ('user', 'ai', 'hybrid')),

  -- Quality flags (Phase 2 computes these; operators can override)
  ADD COLUMN IF NOT EXISTS quality_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- shape: { "blurry": true, "too_dark": false, "duplicate_of": "<photo_id>" }

  -- Capture timestamps
  ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Internal EXIF for proof/dispute — NEVER serve this in client-facing URLs
  ADD COLUMN IF NOT EXISTS original_exif JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Soft delete so undelete is possible within the retention window
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS photos_tenant_customer_idx ON public.photos (tenant_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS photos_job_taken_idx ON public.photos (job_id, taken_at DESC) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS photos_ai_needs_review_idx ON public.photos (tenant_id, created_at DESC)
  WHERE ai_tag IS NULL AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- photo_albums — custom albums only. System albums (Before/After/Progress/
-- Damage/Materials/Customer-Sent/Closeout) are virtual views filtered by tag
-- or other metadata; they don't need rows.
-- ---------------------------------------------------------------------------
CREATE TABLE public.photo_albums (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  job_id UUID REFERENCES public.jobs(id) ON DELETE CASCADE, -- null = tenant-level (e.g. marketing collection)
  name TEXT NOT NULL,
  description TEXT,
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX photo_albums_tenant_job_idx ON public.photo_albums (tenant_id, job_id);

CREATE TABLE public.photo_album_members (
  album_id UUID NOT NULL REFERENCES public.photo_albums(id) ON DELETE CASCADE,
  photo_id UUID NOT NULL REFERENCES public.photos(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (album_id, photo_id)
);

CREATE INDEX photo_album_members_photo_idx ON public.photo_album_members (photo_id);

-- ---------------------------------------------------------------------------
-- photo_pairs — first-class before/after pairings. Not a tag, not a
-- workaround. Either AI-created on job Complete or user-created via
-- manual "Create Pair."
-- ---------------------------------------------------------------------------
CREATE TABLE public.photo_pairs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  job_id UUID REFERENCES public.jobs(id) ON DELETE CASCADE,
  before_photo_id UUID NOT NULL REFERENCES public.photos(id) ON DELETE CASCADE,
  after_photo_id UUID NOT NULL REFERENCES public.photos(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL CHECK (created_by IN ('user', 'ai')),
  ai_confidence NUMERIC(4, 3) CHECK (ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1)),
  layout TEXT NOT NULL DEFAULT 'side_by_side'
    CHECK (layout IN ('side_by_side', 'diagonal', 'slider', 'stacked')),

  -- Path to a pre-rendered branded pair image (generated lazily when first
  -- needed — for reports, social, etc.). Null = not yet rendered.
  rendered_storage_path TEXT,
  rendered_at TIMESTAMPTZ,

  caption TEXT, -- ai or user
  caption_source TEXT NOT NULL DEFAULT 'ai'
    CHECK (caption_source IN ('user', 'ai')),

  approved_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ, -- null = AI suggestion pending operator review
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,

  -- A photo shouldn't appear twice in the same pair (before == after), and
  -- a specific before/after combination shouldn't duplicate.
  CHECK (before_photo_id <> after_photo_id)
);

CREATE UNIQUE INDEX photo_pairs_combo_idx
  ON public.photo_pairs (tenant_id, before_photo_id, after_photo_id)
  WHERE deleted_at IS NULL;

CREATE INDEX photo_pairs_job_idx ON public.photo_pairs (job_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- photo_share_links — scoped, no-login public URLs for clients.
-- ---------------------------------------------------------------------------
CREATE TABLE public.photo_share_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

  -- Opaque token used in the public URL. Generated client-side or via
  -- gen_random_uuid() + base64url encoding at insert time.
  token TEXT NOT NULL UNIQUE,

  -- Polymorphic scope — one of:
  --   job_full    → scope_id = jobs.id, all non-deleted non-internal photos
  --   job_live    → scope_id = jobs.id, live-updating gallery
  --   album       → scope_id = photo_albums.id
  --   pair_set    → scope_id = jobs.id (all approved pairs for that job)
  --   single      → scope_id = photos.id
  scope_type TEXT NOT NULL CHECK (scope_type IN ('job_full', 'job_live', 'album', 'pair_set', 'single')),
  scope_id UUID NOT NULL,

  -- Optional label shown in the admin UI ("Customer closeout — Henderson").
  label TEXT,

  -- Customer-facing contact info (for attribution and re-sharing analytics).
  recipient_email TEXT,
  recipient_phone TEXT,
  recipient_name TEXT,

  expires_at TIMESTAMPTZ, -- null = never expires
  revoked_at TIMESTAMPTZ,

  view_count INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TIMESTAMPTZ,
  last_viewed_ip TEXT,

  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX photo_share_links_scope_idx ON public.photo_share_links (scope_type, scope_id);
CREATE INDEX photo_share_links_tenant_idx ON public.photo_share_links (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- tenant_prefs — namespaced JSONB for per-tenant correction learning.
-- General-purpose: photos is the first consumer, but email_voice, social,
-- and invoicing will plug in later.
--
-- Pattern: ('tenant_xyz', 'photos', { "tag_vocabulary": { "progress": "action" } })
-- ---------------------------------------------------------------------------
CREATE TABLE public.tenant_prefs (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespace)
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE public.photo_albums ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select_photo_albums ON public.photo_albums
    FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_photo_albums ON public.photo_albums
    FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_photo_albums ON public.photo_albums
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_photo_albums ON public.photo_albums
    FOR DELETE TO authenticated USING (tenant_id = public.current_tenant_id());

-- album_members — scope through parent album
ALTER TABLE public.photo_album_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_all_photo_album_members ON public.photo_album_members
    FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM public.photo_albums a
                   WHERE a.id = album_id AND a.tenant_id = public.current_tenant_id()))
    WITH CHECK (EXISTS (SELECT 1 FROM public.photo_albums a
                        WHERE a.id = album_id AND a.tenant_id = public.current_tenant_id()));

ALTER TABLE public.photo_pairs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select_photo_pairs ON public.photo_pairs
    FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_photo_pairs ON public.photo_pairs
    FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_photo_pairs ON public.photo_pairs
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_photo_pairs ON public.photo_pairs
    FOR DELETE TO authenticated USING (tenant_id = public.current_tenant_id());

ALTER TABLE public.photo_share_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select_photo_share_links ON public.photo_share_links
    FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_photo_share_links ON public.photo_share_links
    FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_photo_share_links ON public.photo_share_links
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_photo_share_links ON public.photo_share_links
    FOR DELETE TO authenticated USING (tenant_id = public.current_tenant_id());

ALTER TABLE public.tenant_prefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select_tenant_prefs ON public.tenant_prefs
    FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_tenant_prefs ON public.tenant_prefs
    FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_tenant_prefs ON public.tenant_prefs
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
