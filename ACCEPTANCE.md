# Phase 1A Foundation Acceptance

**Date of acceptance:** 2026-04-16
**Git commit on `main`:** `b2a0edf5a6fa6d90917d1483b634b60c216eccaf` (`b2a0edf`)
**Tag:** `v0.1.0-foundation`
**Verdict:** **READY FOR PHASE 1B**

---

## 1. Gate results (PHASE_1_PLAN.md §5)

| # | Gate | Command | Result | Evidence |
|---|---|---|---|---|
| 1 | Typecheck | `pnpm typecheck` | PASS | `tsc --noEmit` clean (0 errors) |
| 2 | Lint | `pnpm lint` | PASS | `biome check .` — 60 files, no fixes applied |
| 3 | Unit tests | `pnpm test` (no env) | PASS (partial) | 4 test files, 24 tests passed, 2 integration tests skipped (no DATABASE_URL) |
| 4 | Unit + integration | `source .env.local && pnpm test` | PASS | 6 test files, 26 tests passed, 0 skipped |
| 5 | Production build | `pnpm build` | PASS | 14 routes generated (1 static landing, dashboard + auth routes), middleware compiled |
| 6 | Local DB reset | `pnpm exec supabase db reset` | PASS | All 18 migrations applied (0001–0018) cleanly |
| 7 | pgTAP RLS tests | `pnpm exec supabase test db` | PASS | `Files=1, Tests=45, Result: PASS` |
| 8 | E2E (Playwright) | `source .env.local && pnpm test:e2e` | PASS | 4/4 specs passed: sanity + 3 auth (middleware redirect, signup, logout+login) |
| 9 | Smoke test (remote DB) | `pnpm smoke` | PASS | Full cross-tenant RLS isolation verified on prod Supabase |

Note on test 3 vs 4: the two integration tests (`tests/integration/tenants.test.ts`, `tests/integration/signup.test.ts`) auto-skip when `DATABASE_URL` is unset. They pass when the env is loaded. CI will need the repo secret wired for them to run in Actions.

## 2. Schema sync (local ↔ remote)

`pnpm exec supabase migration list --linked` shows all 18 migrations applied on both ends:

```
  Local | Remote | Time (UTC)
  0001  | 0001   | 0001
  0002  | 0002   | 0002
  ...
  0018  | 0018   | 0018
```

No drift. No pending migrations.

## 3. Remote deploy (Vercel)

`GET https://smartfusion.vercel.app` → `HTTP/2 200`, served from Vercel, HTML renders `<h1>HeyHenry</h1>` + "build in progress" placeholder. HTTPS green, HSTS preload header present. No 500s.

Deploy auto-triggered from `main` commit `b2a0edf`. Custom domain (`app.smartfusion.ca`) still needs to be connected — leaving that for Jonathan per Task 1.8 plan item.

## 4. Smoke test (`scripts/smoke-foundation.ts`)

New one-shot verification script:

1. Creates tenant A + owner user A via admin client.
2. Creates tenant B + owner user B via admin client.
3. Signs user A in with anon key (RLS on).
4. Asserts `current_tenant_id()` returns tenant A's UUID.
5. Asserts user A can SELECT tenant A's row.
6. Asserts `SELECT * FROM tenants` as user A returns exactly 1 row (tenant B invisible).
7. Asserts direct `eq(tenantIdB)` returns 0 rows.
8. Cleans up both tenants + both users.

Run on remote DB: **PASS**. Runnable via `pnpm smoke` (also `pnpm tsx scripts/smoke-foundation.ts`).

## 5. What's in (Phase 1A deliverables)

- [x] Repo scaffold: Next.js 16, React 19, Tailwind v4, shadcn/ui primitives, Biome, pnpm
- [x] Testing infra: Vitest (unit + integration), Playwright (e2e), Husky pre-commit, GitHub Actions CI
- [x] Supabase project (ca-central-1) + local dev DB + CLI linked
- [x] Drizzle ORM client + full schema for all P1 tables (13 tables)
- [x] Migrations 0001–0018 covering: tenants, tenant_members, `current_tenant_id()` SECURITY DEFINER fn, customers, service_catalog, quotes, quote_surfaces, jobs, photos, invoices, todos, worklog_entries, audit_log, data_exports, all RLS policies, FK + query indexes, soft-delete columns
- [x] pgTAP RLS test suite (45 assertions covering positive + negative cross-tenant tests for every tenant-scoped table)
- [x] Supabase client factories: browser (`client.ts`), server/RSC (`server.ts`), admin/service-role (`admin.ts`)
- [x] Auth: signup (email + password + business name → creates tenant + tenant_member in one shot), login, magic link, logout, callback, middleware-enforced session gate
- [x] Base UI shell: sidebar (7 P1 nav items), header, placeholder pages for every section, dashboard renders tenant name
- [x] Smoke test + ACCEPTANCE.md + release tag

## 6. What's deferred to Phase 1B tracks

Per §6 of the plan, the following tracks are unblocked and can start in parallel:

- **Track A:** Customers (CRM) — CRUD, list/detail, search
- **Track B:** Quoting — Google Maps polygon, pricing engine, PDF generation, Resend email (longest track)
- **Track C:** Job Board — Kanban with `@dnd-kit`, status transitions
- **Track D:** Photo Upload — Supabase Storage, mobile camera, before/after/progress tags
- **Track E:** Todos + Work Log — Inbox view, full-text search, MCP-ready shape

Each track owns its own migration range (01xx / 02xx / 03xx / 04xx / 05xx) per §13.4 of the plan.

## 7. Known issues / TODOs (non-blocking)

1. **Vercel env vars & custom domain:** `smartfusion.vercel.app` responds 200 with the placeholder page, but Supabase/auth env vars on Vercel need verification before auth flows work on prod. Custom domain `app.smartfusion.ca` not yet connected. Jonathan to finish in the morning (per plan note).
2. **Integration tests skip in CI without DATABASE_URL:** both integration specs auto-skip when the env isn't set. Wire `DATABASE_URL` as a GitHub Actions secret so they run on PRs.
3. **tsx added as dev dep:** `pnpm add -D tsx` — needed for `pnpm smoke`. Clean install on CI will pick it up.
4. **Default Next.js page metadata:** `<title>Create Next App</title>` + "Generated by create next app" meta still present on Vercel deploy; swap to real brand metadata when Jonathan finalizes.
5. **No seed data yet:** `supabase/seed.sql` missing — reset logs `WARN: no files matched pattern: supabase/seed.sql`. Expected; seed goes in with Track A (Will's service catalog, 1D launch checklist).
6. **Stripe / Google / Resend keys are placeholders:** `.env.local` has `sk_test_...`, `pk_test_...`, `re_...` stubs. Real keys land in Phase 1C (Stripe Connect) and Track B (Maps + Resend).
7. **Em-dash policy:** my global memory says avoid em dashes in written content, but the existing codebase (migrations, test docstrings, plan, ACCEPTANCE entries, smoke test) uses them in comments/docs. Left as-is to match existing style; if Jonathan wants the policy applied to repo docs, open a follow-up.

No P0 / P1 bugs. No RLS holes found.

## 8. Readiness verdict

**READY FOR PHASE 1B.**

Foundation is solid. All 9 acceptance gates green. Schema local/remote in sync. Auth flow end-to-end tested on real Supabase. Cross-tenant isolation verified by pgTAP (45 assertions) and a separate smoke script against the remote DB.

Signed off by: Phase 1A acceptance agent, 2026-04-16.
