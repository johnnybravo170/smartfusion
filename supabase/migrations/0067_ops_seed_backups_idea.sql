-- 0067_ops_seed_backups_idea.sql
-- Seed a high-priority idea for the backup infrastructure catch-up so it
-- surfaces in the ops UI and can't get forgotten (again). Idempotent: the
-- existence check keeps repeat runs from duplicating.

INSERT INTO ops.ideas (actor_type, actor_name, title, body, tags, status, rating)
SELECT 'human', 'ops (system seed)', $title$Backup infrastructure — catch up before first paying customer$title$,
  $body$Supabase runs on daily default snapshots only (7-day retention, same AWS
account, no PITR). No off-platform dump, no tested restore drill. Worst case
today = 8 hours of lost data.

Minimum-viable plan (see BACKUPS_PLAN.md for the full version):
1. Enable Supabase PITR (~$100/mo, single biggest win)
2. Nightly pg_dump → encrypted → external store (R2 or S3, separate account)
3. Monthly restore drill, automated
4. Photo storage mirror

Trigger: first paying customer, 2026-05-31, or any data incident — whichever
is earliest. Everything else waits in line behind this.$body$,
  ARRAY['priority-high', 'infrastructure', 'backups', 'security'],
  'new',
  5
WHERE NOT EXISTS (
  SELECT 1 FROM ops.ideas
  WHERE title = 'Backup infrastructure — catch up before first paying customer'
);
