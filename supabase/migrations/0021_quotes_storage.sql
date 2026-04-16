-- Storage bucket for quote PDFs
insert into storage.buckets (id, name, public)
values ('quotes', 'quotes', false)
on conflict (id) do nothing;

-- Tenant-scoped RLS on quote PDFs (path: tenant_id/quote_id.pdf)
drop policy if exists "tenant_select_quotes" on storage.objects;
create policy "tenant_select_quotes" on storage.objects
  for select using (
    bucket_id = 'quotes'
    and (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

drop policy if exists "tenant_insert_quotes" on storage.objects;
create policy "tenant_insert_quotes" on storage.objects
  for insert with check (
    bucket_id = 'quotes'
    and (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

drop policy if exists "tenant_delete_quotes" on storage.objects;
create policy "tenant_delete_quotes" on storage.objects
  for delete using (
    bucket_id = 'quotes'
    and (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );
