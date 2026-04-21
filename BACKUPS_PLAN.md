# Backups — Status and Build Plan

<!-- STATUS: ⚠️ UNBUILT — Supabase daily defaults only. Ship before first paying customer. -->

> **Context.** `PHASE_1_PLAN.md §1D.1` called backup infrastructure
> "non-negotiable from day 1". It got deferred and never came back. This
> doc is the catch-up: what's actually protecting customer data today,
> what's missing, and what to build and when.

## Current state (2026-04-21)

| Layer | Status | Notes |
|------|--------|-------|
| Supabase daily snapshots | ✅ Active | Pro tier default. 7-day retention. Physical backups. |
| Point-in-time recovery (PITR) | ❌ Not enabled | Requires add-on (~$100/mo). |
| Off-platform backup | ❌ None | Lives inside Supabase's AWS account. Same region. |
| Verified restore drill | ❌ Never tested | Untested backups ≈ no backups. |
| Encryption of off-platform copy | ❌ N/A | Moot without off-platform copy. |

**Realistic worst-case today:** a bad migration or admin error at 11 am
can only be recovered from the 03 am daily snapshot — up to 8 hours of
data lost. If Supabase's AWS presence has a catastrophic failure, we
lose everything.

## Target state (minimum viable)

1. **PITR enabled** on Supabase so any incident in the last 7 days is
   recoverable to the second.
2. **Nightly `pg_dump` to an external store** (Cloudflare R2 or AWS S3,
   separate account from Supabase), AES-256 encrypted at rest.
3. **Monthly restore drill** — spin up an empty Supabase project,
   restore the latest dump, verify a handful of rows match prod. One
   script, scheduled, alerts on failure.
4. **Photo storage mirror** — Supabase Storage `photos` bucket also
   mirrored nightly to the same external store (incremental, `aws s3 sync`
   equivalent).

## Build plan

### Phase 1 — Safety floor (target: same week we land our first paying customer, or sooner)

1. **Enable Supabase PITR.** Dashboard → Database → Backups → PITR
   toggle + billing confirm. 7-day window. Single biggest win per
   dollar and zero code change.
2. **Nightly `pg_dump` workflow** — `.github/workflows/nightly-backup.yml`
   running at 03:00 UTC daily. Steps:
   - Install `pg_dump` matching Supabase's Postgres version.
   - Dump with `--format=custom --no-owner --no-acl --clean --if-exists`.
   - Encrypt with `openssl enc -aes-256-cbc` using a key from GH Secrets.
   - Upload to R2/S3 bucket with object-lock for 30 days.
   - Post success/failure to the ops alert email.
3. **Retention:** daily for 30 days, weekly for 12 weeks, monthly for
   12 months. S3/R2 lifecycle rules do this automatically.
4. **Restore drill script** — `scripts/restore-test.ts` that downloads
   the latest dump, decrypts, restores to a temporary Supabase branch
   or a local Postgres, and asserts key row counts / specific records.
   Runs monthly via GH Actions cron.

### Phase 2 — Full DR (target: before 10th paying tenant)

5. **Photo storage mirror** — nightly `rclone sync` of the `photos`
   bucket to the same external store. Respects Supabase RLS path
   convention so restores preserve tenant isolation.
6. **Cross-region replica** — Supabase read replica in a second region
   (us-west-2 or eu-west-1). Failover runbook documented.
7. **Secrets rotation runbook** — if a backup key leaks, how to rotate
   without invalidating the last 30 days of encrypted dumps.
8. **Quarterly DR drill** — actually cut over to the restored copy,
   measure RTO (recovery time) and RPO (data loss window), document.

## Trigger for starting

Earliest of:
- First paying customer signs up
- 2026-05-31
- A security / compliance conversation with any prospect
- Any data incident (however small)

The moment any of these hits, Phase 1 of this plan is the next thing
that ships, ahead of feature work.

## Where this lives elsewhere

- `PHASE_1_PLAN.md` header banner references this doc.
- Seeded as an idea in `ops.ideas` with priority-high tag so it
  surfaces in the ops UI.
- Memory note at `~/.claude/projects/-Users-henry/memory/project_heyhenry_backups.md`
  so future Claude sessions see it immediately.
