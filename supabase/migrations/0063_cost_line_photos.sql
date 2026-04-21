-- 0063_cost_line_photos.sql
-- Photos attached to individual cost lines. Stored as an array of storage
-- paths in the private `photos` bucket. JVD attaches a reference image to a
-- line (e.g. a designer fireplace) so the quote + the field crew both see
-- the visual context.

ALTER TABLE public.project_cost_lines
    ADD COLUMN photo_storage_paths JSONB NOT NULL DEFAULT '[]'::jsonb;
