# Platform Admin — Phase A + B Plan

**Date:** 2026-04-18
**Owner:** Jonathan
**Status:** Spec, awaiting approval to start

## Goal

Ship `/admin/*` — Jonathan's command center inside `app.heyhenry.io`. Phase A is foundation + platform overview. Phase B is Henry interaction analytics. Subsequent phases (marketing, attribution, affiliates, social, admin-Henry tools) are scoped separately.

## Success criteria

- Jonathan can log in as himself and reach `/admin/*` routes; any non-admin authenticated user is redirected to `/dashboard`.
- Overview page shows real numbers across: total tenants, active tenants, signups, voice usage, SMS usage, average Henry activity. No placeholder values for metrics we can calculate today.
- Tenants list is searchable + sortable with per-tenant usage columns.
- Henry analytics page shows real-time charts for interactions/day, top tools, error rate, duration, vertical breakdown — all pulled from `henry_interactions`.
- Every query function + auth helper has a unit test. Each page has at least one integration or render test.
- No regression on existing operator dashboard flows.

## Non-goals (deferred)

- **MRR / ARR / churn / trial counts** — defer until operator-subscription billing exists. Hey Henry doesn't yet charge operators (the app so far is Stripe Connect for *operator → customer*, not *operator → Hey Henry*). Phase A measures what we can actually measure.
- Marketing brain (email/SMS broadcasts, attribution, affiliates, social) — Phase C-F.
- Admin Henry tool surface (impersonate, issue_credit, blast_operators) — Phase F.
- Per-tenant drilldown in analytics — Phase B stretch, ok to defer.

## Phase C design constraints (locked in, will carry forward)

The marketing brain's email + workflow engine must be **MCP-first** for workflow creation. Jonathan's primary interface for spinning up new sequences is Claude (via MCP), not a UI builder. Voice-based workflow creation from the Hey Henry app is nice-to-have, not required. Visual workflow builder is a read/edit surface on top of what Claude/Henry builds, not the primary creation interface.

Required tool surface (exposed via MCP + Gemini function declarations):
- `create_sequence`, `create_step`, `update_sequence`, `pause_sequence`, `list_sequences`
- `trigger_event(event_name, payload)` fires matching sequences
- `segment(filter_dsl)` returns audience ids
- `broadcast(template, audience, schedule)`
- `preview_sequence` — Claude can inspect a dry-run before arming

Required features at launch:
- Native email (Resend) + SMS (Twilio) — already wired
- Multi-step sequences with delays + conditional branches
- Event bus for triggers (job_completed, quote_sent, invoice_paid, customer_inactive_Nd, ...)
- Template system (MJML or Handlebars)
- **Import-from-AWeber** on day one — PG is first migration target ($1,300/yr AWeber cost killed)
- Deliverability baseline: SPF/DKIM/DMARC, bounce/complaint webhooks, suppression list, CAN-SPAM/CASL/GDPR unsubs
- Attribution hooks for Phase C's attribution pipeline

See the vault: "Email System Build-vs-Buy — PG analysis + Hey Henry Phase C implication (April 2026)" for full research + reasoning.

---

## Phase A — Foundation

### A1. Platform admin role + middleware

**Tasks**
- New migration `0039_platform_admins.sql`: table `platform_admins (user_id uuid PK → auth.users, email text, created_at timestamptz)`. RLS off (server-only reads via service role).
- Seed Jonathan's admin row (SQL insert referencing `jonathan@smartfusion.ca` / the corresponding auth.users.id).
- `src/lib/auth/helpers.ts`: add `isPlatformAdmin(userId: string): Promise<boolean>` and `requirePlatformAdmin()` (redirects if not admin).
- Update `middleware.ts` (or Next middleware equivalent): if path matches `/admin/*` AND user is not admin, redirect to `/dashboard`.

**Tests**
- `tests/unit/auth/platform-admin.test.ts` — mock Supabase, assert `isPlatformAdmin()` returns true/false correctly.
- `tests/integration/admin-auth.test.ts` — unauthenticated GET `/admin` → 307 to `/login`; authenticated non-admin → 307 to `/dashboard`; authenticated admin → 200.

**Verify:** run tests. Hit `/admin` in browser while logged in as non-admin → kicked out. While logged in as Jonathan → shell renders.

### A2. `/admin` route group + layout + nav

**Tasks**
- Create route group `src/app/(admin)/admin/layout.tsx`. Server component. Calls `requirePlatformAdmin()` first.
- `src/components/layout/admin-sidebar.tsx` — sidebar with nav items: **Overview**, **Tenants**, **Henry**. (Marketing, Affiliates, Social placeholders commented out until later phases.)
- `src/components/layout/admin-header.tsx` — simplified header, label "Hey Henry Admin", logout, link to operator dashboard.
- Root `/admin` page redirects to `/admin/overview`.
- Distinct color accent or badge ("ADMIN") so Jonathan never forgets which side he's on.

**Tests**
- `tests/unit/components/admin-sidebar.test.tsx` — renders all three nav items, correct hrefs, active state highlights current route.
- Visual smoke: admin layout renders without errors.

**Verify:** /admin → redirects to /admin/overview; sidebar has 3 links; header shows admin badge.

### A3. Platform metrics queries

**Tasks**
- `src/lib/db/queries/platform-metrics.ts`, all server-only, all using the admin Supabase client (service role).
- Functions:
  - `getTotalTenants()` → count of tenants
  - `getActiveTenants(days: 7 | 30)` → count of tenants with any authenticated activity in window (auth.users.last_sign_in_at ≥ now - days, joined via tenant_members)
  - `getSignupsInWindow(days)` → count of tenants created in window
  - `getVoiceMinutesInWindow(days)` → SUM(audio_input_seconds + audio_output_seconds) / 60 from `henry_interactions`
  - `getSmsInWindow(days)` → count of outbound messages from `twilio_messages` in window
  - `getAverageInteractionsPerTenant(days)` → interactions in window / active tenants in window
  - `getDailyTimeseries(days, metric)` → returns `[{day, count}]` for sparklines. Metric is a string key (signups, interactions, voice_minutes, sms).

**Tests**
- `tests/unit/db/queries/platform-metrics.test.ts` — mock Supabase client, assert correct query shape + return value parsing. One test per function.

**Verify:** unit tests pass. Each function runs against dev DB without error and returns plausible numbers.

### A4. Overview page

**Tasks**
- `src/app/(admin)/admin/overview/page.tsx` — server component. Calls queries in parallel, renders:
  - **KPI cards row:** Total Tenants · Active (7d) · Active (30d) · Signups (30d) · Voice mins (30d) · SMS sent (30d) · Avg interactions/tenant (30d)
  - **Trend strip:** four tiny sparklines — signups, interactions, voice minutes, SMS — last 30 days
- New `src/components/features/admin/kpi-card.tsx` — reusable (value, label, delta vs prior period, optional sparkline).
- Timezone: all "days" resolve against `America/Vancouver` (Jonathan's tz) unless we decide otherwise.

**Tests**
- `tests/unit/components/kpi-card.test.tsx` — renders value + label + optional delta.
- `tests/integration/admin-overview.test.ts` — admin GET `/admin/overview` → 200, HTML contains all 7 KPI labels.

**Verify:** open `/admin/overview` → 7 cards filled with real numbers from the DB, 4 sparklines render.

### A5. Tenants list page

**Tasks**
- `src/app/(admin)/admin/tenants/page.tsx` — server component with `searchParams` for query + sort.
- Query function `listAllTenantsWithUsage(filters)` in platform-metrics or new `tenants-admin.ts`:
  - Columns: tenant id, name, slug, vertical, created_at, last_active_at, seat_count, voice_minutes_30d, sms_count_30d.
- Table UI using shadcn Table. Text filter (client-side for now); sortable by any column.
- Row click → `/admin/tenants/[id]` (detail stubbed for now — empty page with "detail coming").

**Tests**
- `tests/unit/db/queries/tenants-admin.test.ts` — assert query shape + usage joins are correct.
- `tests/integration/admin-tenants.test.ts` — admin GET renders expected tenant rows.

**Verify:** visit /admin/tenants → every tenant in the DB shows up, counts match what we already know (e.g., Jonathan's own tenant should show his voice minutes from today's testing).

---

## Phase B — Henry analytics

### B1. Henry analytics queries

**Tasks**
- `src/lib/db/queries/henry-analytics.ts` (platform-scoped, admin-only):
  - `getInteractionsTimeseries(days)` → daily counts
  - `getTopToolCalls(days, limit)` → `[{tool_name, count, distinct_tenants}]` — pulls from existing `henry_tool_usage_by_vertical` view plus flattens across verticals
  - `getErrorRate(days)` → proportion of interactions with non-null `error`
  - `getAverageDurationMs(days)` → AVG(duration_ms)
  - `getTokenUsage(days)` → SUM(input_tokens + output_tokens), SUM(cached_input_tokens)
  - `getInteractionsByVertical(days)` → rows from `henry_usage_by_vertical_daily` aggregated

**Tests**
- `tests/unit/db/queries/henry-analytics.test.ts` — one test per function.

**Verify:** unit tests pass; functions return expected shapes against dev DB.

### B2. Chart primitives

**Tasks**
- Add Recharts dependency: `pnpm add recharts`.
- `src/components/charts/line-chart.tsx`, `bar-chart.tsx`, `sparkline.tsx` — thin wrappers around Recharts with our theme tokens, responsive container, null-safe.
- `src/components/charts/chart-card.tsx` — standard chart card with title + optional time-window toggle.

**Tests**
- `tests/unit/components/charts/line-chart.test.tsx` — renders without errors with empty + populated data.

**Verify:** storybook-style visual smoke in a dev sandbox route works.

### B3. Henry analytics page

**Tasks**
- `src/app/(admin)/admin/henry/page.tsx` — server component. Queries in parallel:
  - **Line chart:** interactions/day (30d default, toggle 7 / 30 / 90)
  - **Bar chart:** top 10 tool calls by volume, with distinct tenants as secondary metric
  - **KPI row:** error rate %, avg duration (seconds), total tokens in window
  - **Stacked bar:** interactions by vertical
- Window selection via `?days=30` search param.

**Tests**
- `tests/integration/admin-henry.test.ts` — admin GET `/admin/henry?days=30` → 200, page title + key element selectors present.

**Verify:** chart data matches raw SQL against the same window; most-used tools pattern matches what you'd expect from your test session (likely `get_current_screen_context`, `fill_current_form`, `create_todo`).

### B4. (Stretch) per-tenant drilldown

Optional; defer if Phase A+B is already ~shipped.

**Tasks**
- `src/app/(admin)/admin/tenants/[id]/henry/page.tsx` — same charts as /admin/henry but filtered by `tenant_id`.
- Reuse query functions, pass optional `tenantId` parameter.

**Verify:** pick a tenant from list → Henry tab → charts filter.

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Forgetting to seed `platform_admins` row → can't reach /admin | Add a dev-mode bootstrap script that seeds Jonathan's admin row when DB is reset. |
| `henry_interactions` table has too few rows for charts to look meaningful during beta | Generate 30d of backfill fake data in a seed script, toggled by `SEED_FAKE_HENRY_DATA=true` env. Off in prod. |
| Middleware edge-cases (API routes under /admin, static assets) | Only gate `/admin/` page routes; API routes under `/api/admin/*` gate separately by reading the session server-side. |
| Recharts SSR issues in Next 16 | Use the 'use client' boundary on chart components; server page passes data as props. |
| Performance on large `henry_interactions` scans | Existing migration already indexed tenant_id + created_at + vertical. Queries use windowed date ranges. Revisit if >1M rows. |

## Estimated time

- Phase A: 2 days focused work (A1–A5)
- Phase B: 1.5 days (B1–B3, skipping B4)
- Total: **3-4 days**, shippable in 2-3 pushes.

## Order of operations

1. A1 — admin role + middleware (land first so subsequent pages can safely gate themselves)
2. A2 — admin layout + nav (visible shell)
3. A3 — platform metrics queries (unit tests green)
4. A4 — overview page (first usable admin surface)
5. A5 — tenants list
6. B1 — Henry analytics queries
7. B2 — chart primitives
8. B3 — Henry analytics page
9. (B4 — per-tenant drilldown, optional)

Each step is shippable on its own. After A1+A2 you have an admin UI with empty pages. After A4 you have real KPIs. After B3 you have full Phase A+B.

## Open decisions before kickoff

1. **Timezone for "days" in metrics** — America/Vancouver (Jonathan's) or UTC? Recommend Vancouver since Jonathan reads the dashboard.
2. **Fake data seeder for charts** — ship it behind an env flag, or wait until real volume arrives?
3. **Chart library** — Recharts is my rec (React-native friendly for the mobile app later). Alternatives: Tremor, Visx, Chart.js. Push back if you prefer something else.
