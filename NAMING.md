# Naming Conventions

Lock terms in place so the same concept doesn't drift back into multiple names. When you introduce a new term that's likely to be reused (especially anything that touches the DB schema, the UI, AI prompts, AND code at the same time), add it here.

## Budget category vs storage bucket

The word "bucket" is **reserved** for Supabase Storage. The budget concept is "budget category" everywhere else. Both names apply at the same nouns level (DB table, code variable, UI label, AI prompt prose), so any drift creates confusion.

| Concept | Term | Where it shows up |
|---|---|---|
| The budget grouping inside a project (e.g. "Plumbing", "Demo") | **budget category** | DB table `project_budget_categories`, FK column `budget_category_id`, TS types like `StarterTemplateCategory`, UI labels ("Categories"), AI prompts ("budget categories") |
| The named container in Supabase Storage that holds files (`photos`, `documents`, `memos`, etc.) | **storage bucket** | `supabase.storage.from('photos')`, constants like `PHOTOS_BUCKET`, `STORAGE_BUCKET` |

### Why this is a rule, not a preference
Migration `0147_rename_cost_buckets_to_budget_categories.sql` (April 2026) renamed the DB tables but the application code lagged for weeks; a follow-up cleanup card found 1,500+ stale "bucket" references including a latent bug in `bucket-templates.ts` that was sending `buckets:` to a column called `categories`. Migration `0171_rename_change_orders_affected_buckets.sql` (May 2026) finished the rename for the `change_orders.affected_buckets` JSONB column.

### Don't rename if
- It's a **storage bucket** (`storage.from('photos')`, `STORAGE_BUCKET`, `PHOTOS_BUCKET`).
- It's a **generic grouping** that happens to use the word "bucket" but isn't the budget concept (dashboard task buckets like `overdue/today/blocked`, photo gallery `photoBuckets` keyed by tag, time-series accumulator buckets, vendor cluster counters, GST remittance accumulators). These were intentionally left alone — they're a generic English use of "bucket" meaning "group", not the operator-facing budget concept.
- It's an **already-applied migration file** (`supabase/migrations/*.sql`). Migration history is sacred; never rewrite it.

### Backcompat note
- `quote_templates.snapshot` JSONB historically used `{ buckets: [...] }`. New writes emit `{ categories: [...] }`. Reads normalize via `snapshot.categories ?? snapshot.buckets ?? []`. Don't backfill — the normalizer is cheap and the backcompat read keeps old saved templates working forever.
- `?tab=buckets` URL alias on `src/app/(dashboard)/projects/[id]/page.tsx` redirects to `?tab=budget`. Keep the alias — old bookmarks shouldn't 404.

### When you find a "bucket" reference
1. Decide which of the two concepts it is. If unsure, look for `storage.from(`, `bucketName`, or a known storage-bucket string ('photos', 'documents', 'memos', 'intake', 'audio', 'portal', 'home-record', 'share', 'receive', 'exports', 'signatures', 'logos', 'zips', 'project-checklist', 'home-record-pdfs', 'home-record-zips', 'intake-audio') nearby — those are storage.
2. If it's the budget concept, rename it (`bucket` → `category`, `bucketId` → `budgetCategoryId`, etc.).
3. If it's storage, leave it alone.
4. If it's neither (a generic "group" usage), leave it alone but consider whether a less-loaded word would read clearer.
