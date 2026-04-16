-- 0020_photos_storage.sql
-- Supabase Storage bucket + RLS for the photos feature (Track D).
--
-- Path convention: `{tenant_id}/{job_id}/{photo_id}.{ext}`. Tenant isolation
-- is enforced by matching the first path segment against
-- `public.current_tenant_id()` (installed in 0003). We do NOT rely on the
-- caller to pass the tenant id — we derive it from the authenticated JWT's
-- tenant_members row, same contract every other `public.*` policy uses.
--
-- The bucket is private. All reads go through signed URLs minted server-side
-- after an RLS SELECT on `storage.objects` passes, so a cross-tenant leak
-- would require both a bug in the URL signer AND a broken policy.
--
-- Idempotent: the `on conflict` on the bucket insert and `drop policy if
-- exists` calls let `supabase db reset` replay this migration safely.

-- Create the private storage bucket.
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

-- SELECT: a member can read objects whose path prefix matches their tenant.
drop policy if exists "tenant_select_photos" on storage.objects;
create policy "tenant_select_photos" on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'photos'
    and (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

-- INSERT: same check on WITH CHECK; the server action generates the path.
drop policy if exists "tenant_insert_photos" on storage.objects;
create policy "tenant_insert_photos" on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'photos'
    and (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

-- UPDATE: guard both sides (USING + WITH CHECK) to prevent moving an object
-- across tenants by rewriting `name`.
drop policy if exists "tenant_update_photos" on storage.objects;
create policy "tenant_update_photos" on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'photos'
    and (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  )
  with check (
    bucket_id = 'photos'
    and (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

-- DELETE: the photo row's tenant owns the object.
drop policy if exists "tenant_delete_photos" on storage.objects;
create policy "tenant_delete_photos" on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'photos'
    and (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );
