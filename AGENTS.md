<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Match existing patterns

Read `PATTERNS.md` at the start of any UI or flow change. It catalogs reusable patterns (upload zones, customer pick-or-create, confirm dialogs, inline edits, status badges, empty states, tabs, server-action result shape).

When you change one instance of a pattern (e.g. add drag-drop to the logo uploader), evaluate every sibling instance listed in `PATTERNS.md` for the same family and **surface them to the user with a "should I update these too?" prompt**. Do not silently update siblings, and do not silently skip them. Let the user decide per-sibling.

When you introduce a new flow worth standardizing — or extract a one-off into a reusable component — update `PATTERNS.md` in the same change.

# Database migrations

**Always use timestamp-prefixed filenames for new migrations.** Format: `YYYYMMDDHHMMSS_short_name.sql` — 14 UTC digits, underscore, snake_case slug, `.sql`. Example: `20260507210400_photos_import_batch.sql`.

The legacy `NNNN_name.sql` 4-digit format still exists in the repo but **don't add new ones in that style**. The 4-digit scheme silently corrupts when two PRs claim the same number — Supabase's migration tracker keys on the prefix and only registers one of them; the other's SQL is recorded as "applied" but never runs. Phases ship live in code with no DB schema behind them, and the bug surfaces only when something tries to use the missing column. Both styles sort lexicographically so mixing them keeps the apply order intact forever.

`supabase migration new <slug>` (the official CLI) generates the timestamp format by default — use that, not a hand-typed prefix.

Two guards exist:
- `scripts/check-migration-prefixes.ts` runs in CI and fails on intra-tree duplicates.
- `.husky/pre-push` fetches `origin/main` and bails if a migration you're about to push collides with one already on remote (catches the rebase-and-forget case).

Both are bypassable (`git push --no-verify`); don't reach for the bypass casually — silent skips are exactly what these guards exist to prevent.
