-- Tenant preference: automatically add every worker to every new project.
alter table tenants
  add column if not exists auto_assign_crew boolean not null default false;
