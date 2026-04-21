-- 0062_portal_updates_photo_storage_path.sql
-- Portal updates uploaded via the new form go into the private `photos`
-- bucket. We store the storage path and sign at render time so the public
-- portal page can display the image without exposing a permanent URL.
-- Legacy `photo_url` remains for externally-hosted photos (memo extraction).

ALTER TABLE public.project_portal_updates
    ADD COLUMN photo_storage_path TEXT;
