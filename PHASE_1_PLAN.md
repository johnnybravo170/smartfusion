# Contractor OS — Phase 1 Implementation Plan
<!-- STATUS: COMPLETE — Archived 2026-04-19. All phases (1A foundation, 1B feature tracks, 1C integration, 1D hardening) shipped. See ACCEPTANCE.md for gate results. -->

> ⚠️ **UNBUILT CARVEOUT: Backup infrastructure (§1D.1).** Called "non-negotiable from day 1"
> in this doc, then deferred and forgotten. Production today runs on Supabase daily defaults
> only — no PITR, no off-platform copy, no tested restore drill. See **BACKUPS_PLAN.md**
> for the catch-up plan. Target: ship before first paying customer.

> **Code name:** Smartfusion (placeholder — Jonathan owns smartfusion.ca; final brand TBD)
> **Target:** Ship a working quoting + job + invoicing app that Will (pressure washing, Abbotsford BC) uses for real customers.
> **Definition of done:** Will sends 3 real quotes through the app, collects payment on at least 1 completed job through Stripe Connect, and says "I'd pay for this today."

---

## 1. Scope (What's In / What's Out)

### In scope (Phase 1 modules)
| # | Module | Why it's in P1 |
|---|---|---|
| 1 | **Auth + Multi-tenancy** | Nothing works without tenant isolation |
| 2 | **Quoting Engine** (Google Maps polygon → sqft → PDF) | Will's #1 pain point; the demo that sells |
| 3 | **Customers (CRM)** | Quotes need to attach to someone |
| 4 | **Job Board** (quoted → booked → in progress → complete) | The daily operations view |
| 5 | **Invoicing + Stripe Connect** | How Will gets paid |
| 6 | **Photo Upload** (job-attached, before/after tags) | Feeds Phase 2 marketing module |
| 7 | **Todo List** | Built MCP-first so Phase 2 voice works natively |
| 8 | **Work Log** | The AI memory substrate for Phase 2 |
| 9 | **Backup infrastructure** | Non-negotiable from day 1 — customer data is sacred |

### Explicitly deferred (Phase 2+)
- MCP server (but: all data shapes are MCP-ready)
- Email workflow engine
- Review automation (Twilio SMS)
- Route optimization
- AI chat widget
- Custom domains / white-label
- Change orders / customer portal (renovation vertical)
- Affiliate program
- Dashboard analytics beyond basic totals

### Naming note
Final brand is TBD. Phase 1 ships under **smartfusion.ca** and `app.smartfusion.ca`. When a real brand lands, a rename is a 1-day Vercel config + env var change — all code references a `BRAND` constant.

---

## 2. What I Need From You Before We Start

### 2.1 Accounts to create (~45 min total)

| # | Account | Plan | Cost | Why |
|---|---|---|---|---|
| 1 | **GitHub** | Private repo | Free | Source hosting |
| 2 | **Supabase** | Free tier to start, Pro when we hit launch | $0 → $25/mo | DB + Auth + Storage, Canadian region |
| 3 | **Vercel** | Hobby to start, Pro at launch | $0 → $20/mo | Next.js hosting + preview deploys |
| 4 | **Stripe** | Standard (we'll set up Connect inside) | Free + 2.9%+$0.30 | Payments |
| 5 | **Google Cloud** | Billing enabled, Maps JS API + Places API | $0 (within $200 monthly credit) | Polygon drawing, address autocomplete |
| 6 | **Resend** | Free tier (3K emails/mo) | Free | Transactional email (quotes, invoices) |
| 7 | **Anthropic API** | Existing | Existing | Claude for PDF/caption generation |

**Already have:** Anthropic API, smartfusion.ca domain, Cloudflare or registrar DNS access.

**Deferred to later in P1 or to P2:**
- Twilio (SMS) — deferred; email is enough for P1
- AWS S3 (offsite backup) — set up in week 5 before launch, not day 1
- Backblaze B2 (photo backup mirror) — Phase 2

### 2.2 Decisions I need from you

1. **Domain layout for P1** — confirm:
   - `smartfusion.ca` → marketing landing (or just redirect to app for now)
   - `app.smartfusion.ca` → the dashboard (Next.js)
   - Proposed answer: skip marketing site entirely in P1, redirect apex → app

2. **Will's real pricing** — need from Will, in a 30-min session:
   - Surface types he quotes (driveway, house siding, deck, roof, concrete pad, etc.)
   - Price per sqft OR flat per surface for each
   - Minimum job charge
   - GST/PST handling (BC: 5% GST + PST N/A for cleaning services — verify)
   - Typical job deposit % (if any)

3. **Tech stack confirmations** — my recommendations, reply "ok" or push back:
   - **Framework:** Next.js 15 App Router + React Server Components
   - **UI:** shadcn/ui + Tailwind CSS v4
   - **Forms/validation:** React Hook Form + Zod
   - **DB client:** Drizzle ORM on top of Supabase Postgres (type-safe migrations)
   - **Auth:** Supabase Auth (Google OAuth + email magic link)
   - **Testing:** Vitest (unit) + Playwright (E2E)
   - **Package manager:** pnpm
   - **Linter/formatter:** Biome (fast, replaces ESLint+Prettier)
   - **Deploy:** Vercel, single Next.js app (no monorepo yet)

4. **Will's commitment** — confirm with him:
   - Willing to be beta tester, weekly 15-min feedback calls
   - Willing to send real quotes through it by week 5
   - OK with us using his business data for screenshots/case study

### 2.3 Things I will handle autonomously (no input needed)
- All architecture decisions inside the stack
- Schema design
- Test design
- Code organization
- Naming of internal modules (not brand)
- Vercel preview URL management
- Supabase CLI + migration workflow

---

## 3. High-Level Architecture (P1 Only)

```
┌─────────────────────────────────────────────────────────────┐
│  Next.js 15 App (app.smartfusion.ca → Vercel)               │
│  ├─ /app/(auth)/login, signup, magic-link                  │
│  ├─ /app/(dashboard)/dashboard                             │
│  ├─ /app/(dashboard)/customers                             │
│  ├─ /app/(dashboard)/quotes/new (polygon drawing)          │
│  ├─ /app/(dashboard)/jobs                                  │
│  ├─ /app/(dashboard)/invoices                              │
│  ├─ /app/(dashboard)/settings                              │
│  └─ Server Actions + Route Handlers (PDF gen, webhooks)    │
└──────────────────┬──────────────────────────────────────────┘
                   │
    ┌──────────────┼──────────────┬──────────────┐
    │              │              │              │
┌───▼───────┐ ┌────▼─────┐ ┌──────▼─────┐ ┌──────▼──────┐
│ Supabase  │ │  Stripe  │ │  Google    │ │   Resend    │
│ (Postgres │ │ (Connect │ │  Maps +    │ │  (email)    │
│  + Auth + │ │  + Pay)  │ │  Places)   │ │             │
│  Storage) │ │          │ │            │ │             │
│ ca-central│ │          │ │            │ │             │
└───────────┘ └──────────┘ └────────────┘ └─────────────┘
```

Multi-tenancy: **every table has `tenant_id`**, **every policy filters on `auth.jwt() ->> 'tenant_id'`**. This is our most-tested invariant.

---

## 4. Repo Layout

```
~/projects/smartfusion/
├── README.md
├── PHASE_1_PLAN.md          ← this file
├── DECISIONS.md             ← running log of architecture decisions
├── .env.local.example
├── .gitignore
├── package.json
├── pnpm-lock.yaml
├── biome.json
├── playwright.config.ts
├── vitest.config.ts
├── next.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── drizzle.config.ts
│
├── supabase/
│   ├── migrations/          ← versioned SQL, one per change
│   ├── seed.sql             ← dev seed data (Will's tenant)
│   └── tests/               ← pgTAP RLS tests
│
├── src/
│   ├── app/
│   │   ├── (auth)/
│   │   ├── (dashboard)/
│   │   ├── (public)/        ← marketing + signup, no auth
│   │   ├── api/             ← webhooks only (Stripe, Resend)
│   │   └── layout.tsx
│   ├── components/
│   │   ├── ui/              ← shadcn primitives
│   │   └── features/        ← feature components
│   ├── lib/
│   │   ├── db/              ← Drizzle schema + queries
│   │   ├── auth/            ← Supabase helpers
│   │   ├── pricing/         ← quoting logic (pure functions)
│   │   ├── pdf/             ← PDF generation
│   │   ├── stripe/          ← Stripe Connect helpers
│   │   ├── storage/         ← Supabase Storage helpers
│   │   └── validators/      ← Zod schemas (shared)
│   └── server/
│       └── actions/         ← Server Actions (one file per module)
│
├── tests/
│   ├── unit/                ← Vitest
│   ├── integration/         ← Vitest + test DB
│   └── e2e/                 ← Playwright
│
└── scripts/
    ├── seed-will.ts         ← seeds Will's tenant
    ├── backup-now.ts        ← manual backup trigger
    └── restore-test.ts      ← restore verification
```

---

## 5. Feedback Loops Baked In

Every module has **four verification layers**. A module is NOT done until all four pass.

### Layer 1: Type-check + lint (per commit, per PR)
- `pnpm typecheck` — TypeScript strict
- `pnpm lint` — Biome
- `pnpm build` — production build succeeds
- Runs in: pre-commit hook (Husky) + GitHub Actions

### Layer 2: Unit tests (per commit)
- Pure logic: pricing calculations, PDF builders, date math, validators
- **Goal:** 100% coverage of `src/lib/pricing/` and `src/lib/validators/`
- Runs in: pre-commit (changed files) + CI (all)
- Command: `pnpm test`

### Layer 3: Integration tests (on PR)
- Against a local Supabase instance (via `supabase start`)
- Every RLS policy gets a test: "user in tenant A CANNOT see tenant B's data"
- Every server action gets a test: happy path + auth failure + RLS isolation
- Runs in: GitHub Actions with Supabase CLI
- Command: `pnpm test:integration`

### Layer 4: E2E tests (on PR, before merge)
- Playwright scripts for every user flow:
  - Sign up → create tenant → log in
  - Create customer → create quote → draw polygon → generate PDF
  - Book quote as job → mark in-progress → complete → generate invoice → pay (Stripe test mode)
  - Upload photo → see in job detail
  - Add todo → complete todo
  - Add work log entry → search for it
- Runs in: GitHub Actions on PR, headed locally for dev
- Command: `pnpm test:e2e`

### Layer 5: Human dogfooding (weekly)
- **Week 2 check-in with Will:** sketch-level UI walkthrough, "does this match how you think about quotes?"
- **Week 4 check-in:** Will creates a fake quote on staging for his own house
- **Week 5 check-in:** Will sends a real quote to a real customer
- **Week 6 go-live:** Will runs his business on it for a week

### Verification cheat-sheet for each module

Each task in §8 includes a **"How to verify this works"** block with:
1. Exact test command to run
2. Expected output
3. A manual UI check ("click X, see Y")
4. A negative test ("try to access tenant B's data as tenant A, confirm 404")

---

## 6. Parallel Agent Strategy

This project is structured so that after the Foundation phase, **5 independent feature tracks can run in parallel** using subagents. Each track owns its files, tests, and PR. The schema is designed up-front so tracks don't collide on migrations.

### Phase 1A — Foundation (sequential, ~5-7 days)
**Cannot be parallelized.** One agent does this end-to-end because every subsequent track depends on it.

1. Repo init, tooling, CI
2. Supabase project, migrations framework, base RLS
3. Auth flow (login, signup, tenant creation)
4. Base UI shell + navigation
5. Drizzle schema for ALL P1 tables (even empty ones) — lets tracks import types immediately

### Phase 1B — Feature Tracks (parallel, ~2-3 weeks)
Each track is an independent subagent with its own worktree and branch. They share: schema, auth, UI shell. They do not touch each other's files.

| Track | Owner files | Dependencies | Can start when |
|---|---|---|---|
| **A: Customers (CRM)** | `src/app/(dashboard)/customers/*`, `src/server/actions/customers.ts`, `src/lib/db/queries/customers.ts` | Foundation only | 1A done |
| **B: Quoting** | `src/app/(dashboard)/quotes/*`, `src/lib/pricing/*`, `src/lib/pdf/*` (quote PDF), map component | Foundation + Customers table | 1A done |
| **C: Jobs** | `src/app/(dashboard)/jobs/*`, `src/server/actions/jobs.ts`, status workflow | Foundation + Quotes table | 1A done (jobs reads from quotes but doesn't create them) |
| **D: Photos** | `src/components/features/photo-upload/*`, storage helpers, `src/server/actions/photos.ts` | Foundation | 1A done |
| **E: Todos + Work Log** | `src/app/(dashboard)/inbox/*`, `src/server/actions/todos.ts`, `src/server/actions/worklog.ts` | Foundation | 1A done |

### Phase 1C — Integration (sequential, ~1 week)
Single agent wires modules together:
1. Quote → Job conversion flow
2. Job → Invoice flow (with Stripe Connect)
3. Stripe Connect onboarding wizard
4. Invoice payment + webhook handler
5. End-to-end Playwright script "Will's full day"

### Phase 1D — Hardening + Launch (sequential, ~1 week)
1. Backup cron verified (scripted restore to staging)
2. Data export (PIPEDA) endpoint
3. Error monitoring (Sentry wired)
4. Analytics (PostHog or Plausible)
5. Will's dogfood week

### Reviewer agents (run on every PR, parallel to author)
- **Security reviewer** — reads diffs, flags RLS holes, auth bypasses, unvalidated inputs
- **Simplification reviewer** — flags over-abstraction, duplicated logic, YAGNI violations
- **Test reviewer** — flags missing tests, untested branches, integration gaps

These run automatically in the execution mode — each PR gets one pass before merge.

### How the parallelization actually looks on the calendar

```
Week 1:  [========== Foundation (1A) ==========]
Week 2:  [A]  [B]  [C]  [D]  [E]    ← 5 parallel tracks launch
Week 3:  [A]  [B]  [C]  [D]  [E]    ← continue
Week 4:  [A✓] [B]  [C✓] [D✓] [E✓]   ← most tracks wrap, B (quoting) longest
Week 5:  [=========== Integration (1C) ==========]
Week 6:  [=========== Launch (1D) + Will dogfood ==========]
```

Realistic range: 5-7 weeks total. My best guess is 6 weeks assuming no major blockers and Will is available for weekly feedback.

---

## 7. Database Schema (Full P1)

All tables have `tenant_id UUID NOT NULL`, `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ`. Every table gets a matching RLS policy: `tenant_id = auth.jwt() ->> 'tenant_id'`.

```sql
-- Auth + tenancy
tenants               (id, name, slug, stripe_account_id, stripe_onboarded_at, currency, timezone, province, gst_rate, pst_rate, created_at)
tenant_members        (tenant_id, user_id, role, created_at)           -- role: owner | admin | member
users                 -- managed by Supabase Auth, we mirror id into tenant_members

-- CRM
customers             (id, tenant_id, type, name, email, phone, address_line1, city, province, postal_code, lat, lng, notes, created_at)
                      -- type: residential | commercial | agent

-- Quoting
quotes                (id, tenant_id, customer_id, status, total_cents, subtotal_cents, tax_cents, notes, pdf_url, sent_at, created_at)
                      -- status: draft | sent | accepted | rejected | expired
quote_surfaces        (id, quote_id, surface_type, polygon_geojson, sqft, price_cents, notes)
                      -- surface_type: driveway | house_siding | deck | roof | concrete_pad | custom
service_catalog       (id, tenant_id, surface_type, label, price_per_sqft_cents, min_charge_cents, is_active)

-- Jobs
jobs                  (id, tenant_id, customer_id, quote_id, status, scheduled_at, started_at, completed_at, notes, created_at)
                      -- status: booked | in_progress | complete | cancelled

-- Photos
photos                (id, tenant_id, job_id, storage_path, tag, caption, taken_at, created_at)
                      -- tag: before | after | progress | other

-- Invoicing
invoices              (id, tenant_id, customer_id, job_id, status, amount_cents, tax_cents, stripe_invoice_id, stripe_payment_intent_id, pdf_url, sent_at, paid_at, created_at)
                      -- status: draft | sent | paid | void

-- Productivity
todos                 (id, tenant_id, user_id, title, done, due_date, related_type, related_id, created_at)
                      -- related_type: customer | quote | job | invoice | null
worklog_entries       (id, tenant_id, user_id, entry_type, title, body, related_type, related_id, created_at)
                      -- entry_type: note | system | milestone

-- System
audit_log             (id, tenant_id, user_id, action, resource_type, resource_id, metadata_json, created_at)
data_exports          (id, tenant_id, user_id, status, download_url, expires_at, created_at)
```

Migration files (one per table, numbered):
```
0001_tenants.sql
0002_tenant_members.sql
0003_customers.sql
0004_service_catalog.sql
0005_quotes.sql
0006_quote_surfaces.sql
0007_jobs.sql
0008_photos.sql
0009_invoices.sql
0010_todos.sql
0011_worklog_entries.sql
0012_audit_log.sql
0013_data_exports.sql
0014_rls_policies.sql       -- all policies in one file for auditability
0015_indexes.sql            -- FK + query indexes
```

---

## 8. Task Breakdown

Each task: **2-5 minute chunks**, TDD where logic exists, committed with a descriptive message.

### Phase 1A — Foundation

#### Task 1.1: Repo scaffold
**Files created:** `package.json`, `tsconfig.json`, `.gitignore`, `README.md`, `biome.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`, `src/app/layout.tsx`, `src/app/page.tsx`
**Steps:**
- [ ] `pnpm create next-app@latest . --typescript --tailwind --app --src-dir --no-eslint`
- [ ] `pnpm add -D @biomejs/biome && pnpm biome init`
- [ ] Install shadcn/ui: `pnpm dlx shadcn@latest init`
- [ ] Add base components: button, input, form, card, table, dialog, toast, select
- [ ] Create README with one-paragraph summary
- [ ] Commit: `chore: scaffold next.js + shadcn + biome`
**Verify:** `pnpm dev` opens localhost:3000, default page renders, no console errors.

#### Task 1.2: Testing + CI infrastructure
**Files:** `vitest.config.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`, `tests/unit/sanity.test.ts`, `tests/e2e/sanity.spec.ts`, `.husky/pre-commit`
**Steps:**
- [ ] `pnpm add -D vitest @vitest/ui jsdom @testing-library/react @testing-library/jest-dom`
- [ ] `pnpm add -D @playwright/test && pnpm exec playwright install chromium`
- [ ] Write sanity unit test: `expect(1+1).toBe(2)` — confirm runner works
- [ ] Write sanity E2E: visit `/`, assert `h1` exists
- [ ] Install Husky + lint-staged, pre-commit runs biome + changed unit tests
- [ ] GitHub Actions: typecheck, lint, unit, build
- [ ] Commit: `chore: testing + CI`
**Verify:** `pnpm test` passes. `pnpm test:e2e` passes. Push branch, confirm CI green.

#### Task 1.3: Supabase project + CLI
**Files:** `supabase/config.toml`, `.env.local.example`, `src/lib/supabase/client.ts`, `src/lib/supabase/server.ts`
**Steps:**
- [ ] Create Supabase project (ca-central-1), save keys to `.env.local`
- [ ] `pnpm add @supabase/supabase-js @supabase/ssr`
- [ ] `pnpm add -D supabase` (CLI as dev dep)
- [ ] `pnpm exec supabase init`
- [ ] `pnpm exec supabase link --project-ref <id>`
- [ ] `pnpm exec supabase start` locally — confirm local DB up
- [ ] Write `src/lib/supabase/client.ts` (browser) and `server.ts` (RSC)
- [ ] Commit: `feat: supabase client + local dev DB`
**Verify:** `supabase status` shows all services running. From a test route, fetch `auth.getSession()` returns null (not an error).

#### Task 1.4: Drizzle setup + first migration
**Files:** `drizzle.config.ts`, `src/lib/db/schema/*.ts`, `src/lib/db/client.ts`, `supabase/migrations/0001_tenants.sql`
**Steps:**
- [ ] `pnpm add drizzle-orm postgres && pnpm add -D drizzle-kit`
- [ ] Write `src/lib/db/schema/tenants.ts` with the Drizzle schema
- [ ] Generate migration via drizzle-kit → copy into `supabase/migrations/`
- [ ] Apply: `pnpm exec supabase db reset` (local)
- [ ] Write integration test: insert tenant, query it back
- [ ] Commit: `feat: tenants table + drizzle`
**Verify:** `pnpm test:integration tenants` passes. `psql` into local DB, confirm table exists with correct columns.

#### Task 1.5: All P1 tables + RLS (bulk migration)
**Files:** `supabase/migrations/0002-0015_*.sql`, `src/lib/db/schema/*.ts` (one per table)
**Steps:**
- [ ] Write schema files for all tables from §7
- [ ] Write RLS policy migration (0014) — every table: `USING (tenant_id::text = auth.jwt() ->> 'tenant_id')`
- [ ] Write indexes migration (0015): FK indexes + common query indexes
- [ ] Write pgTAP RLS tests in `supabase/tests/rls.sql` — for each table, attempt cross-tenant read/write as wrong user, expect 0 rows / error
- [ ] `supabase db reset`, run tests
- [ ] Commit: `feat: full schema + RLS`
**Verify:**
```bash
pnpm exec supabase db reset
pnpm exec supabase test db
```
Expected: all pgTAP tests pass. Every table has a positive test (tenant A sees own data) and a negative test (tenant A cannot see tenant B).

#### Task 1.6: Auth flow (signup creates tenant)
**Files:** `src/app/(auth)/login/page.tsx`, `src/app/(auth)/signup/page.tsx`, `src/app/(auth)/callback/route.ts`, `src/server/actions/auth.ts`, `src/middleware.ts`
**Steps:**
- [ ] Signup form: email + business name + password OR magic link
- [ ] On signup: create tenant, create tenant_member with role=owner, set JWT custom claim `tenant_id`
- [ ] Use Supabase [custom claims hook](https://supabase.com/docs/guides/auth/auth-hooks) to inject `tenant_id` into JWT
- [ ] Middleware: redirects `/app/*` to `/login` if no session; redirects authed users to `/dashboard`
- [ ] Write E2E: signup → land on empty dashboard
- [ ] Write integration test: new signup creates tenant row + tenant_member row
- [ ] Commit: `feat: auth + tenant creation`
**Verify:**
```bash
pnpm test:e2e auth
```
Expected: signup flow completes, user sees `/dashboard`. Check Supabase Auth dashboard: user exists, JWT contains `tenant_id` claim.

#### Task 1.7: Base UI shell + navigation
**Files:** `src/app/(dashboard)/layout.tsx`, `src/components/layout/sidebar.tsx`, `src/components/layout/header.tsx`, empty pages for each section
**Steps:**
- [ ] Sidebar with links: Dashboard, Customers, Quotes, Jobs, Invoices, Inbox (todos + worklog), Settings
- [ ] Header with business name + user menu (logout)
- [ ] Each page renders empty state with "coming soon" placeholder
- [ ] Dashboard page fetches tenant name, displays "Welcome, {business}"
- [ ] Commit: `feat: dashboard shell`
**Verify:** Navigate through every sidebar link, no errors, tenant name shown correctly.

#### Task 1.8: Foundation acceptance gate
**Steps:**
- [ ] Run full test suite: typecheck, lint, unit, integration, e2e, RLS
- [ ] Merge to `main`, confirm Vercel preview deploys successfully
- [ ] Connect `app.smartfusion.ca` to Vercel
- [ ] Manual smoke test on prod URL: signup → dashboard
- [ ] Commit tag: `v0.1.0-foundation`
**Verify checklist (all must pass before opening parallel tracks):**
- [ ] `pnpm test` passes
- [ ] `pnpm test:integration` passes
- [ ] `pnpm test:e2e` passes
- [ ] `pnpm exec supabase test db` passes (RLS)
- [ ] Prod URL reachable, HTTPS green
- [ ] Can create account on prod, tenant row exists

---

### Phase 1B — Feature Tracks (Parallel)

Each track below is designed as a standalone prompt you hand to a subagent. Each includes: scope, files it owns, files it MUST NOT touch, tests required, definition of done.

#### Track A — Customers (CRM)

**Scope:** CRUD for customers, with type-aware forms (residential/commercial/agent).

**Owns:**
- `src/app/(dashboard)/customers/page.tsx` (list)
- `src/app/(dashboard)/customers/new/page.tsx`
- `src/app/(dashboard)/customers/[id]/page.tsx`
- `src/server/actions/customers.ts`
- `src/lib/db/queries/customers.ts`
- `src/lib/validators/customer.ts`
- `tests/unit/customer.test.ts`
- `tests/e2e/customers.spec.ts`

**Must NOT touch:** any other feature's folders, schema files (already exist from 1A).

**Tasks:**
- [ ] Zod schema: `customerSchema` (name, type, email optional, phone optional, address, etc.)
- [ ] Server actions: `createCustomer`, `updateCustomer`, `deleteCustomer`, `listCustomers`, `getCustomer` — all use tenant-scoped queries
- [ ] List page: table with name, type, phone, created_at, search box
- [ ] Detail page: customer info + "related quotes/jobs/invoices" tabs (stub for now, wire in 1C)
- [ ] New/Edit page: form with conditional fields by type
- [ ] E2E: create customer → appears in list → click → see detail → edit → delete
- [ ] Integration test: tenant A creates customer, tenant B lists customers, sees 0

**Done when:**
- All 6 customer flows have E2E coverage
- RLS negative test passes
- UI reviewed on mobile width (375px)
- Branch merged to main

#### Track B — Quoting Engine (longest track, 3 weeks estimate)

**Scope:** The showpiece feature. Address autocomplete → map → polygon → sqft → pricing → PDF.

**Owns:**
- `src/app/(dashboard)/quotes/*`
- `src/components/features/map-polygon/*` (Google Maps component)
- `src/lib/pricing/*` (pure pricing logic)
- `src/lib/pdf/quote-pdf.ts`
- `src/server/actions/quotes.ts`
- `src/lib/db/queries/quotes.ts`
- `tests/unit/pricing.test.ts`
- `tests/e2e/quotes.spec.ts`

**Sub-tasks:**
- [ ] **B.1** Service catalog CRUD (settings page): add/edit surface types + prices. Seed Will's 5-7 surfaces.
- [ ] **B.2** Pricing engine (pure functions, zero external deps):
  - `calculateSurfacePrice(surface, catalog): Cents` — sqft × price + min_charge handling
  - `calculateQuoteTotal(surfaces, taxRate): {subtotal, tax, total}`
  - 100% unit test coverage including: min_charge kicks in, tax rounding, empty quote
- [ ] **B.3** Google Maps polygon component:
  - Load Google Maps JS API with Places + Drawing libraries
  - Address search → geocode → center map + satellite view
  - User draws polygon → `google.maps.geometry.spherical.computeArea(path)` → sqft (×10.764)
  - Label each polygon with surface type dropdown
  - Delete/edit polygons
- [ ] **B.4** Quote form: customer picker, surfaces list (from polygons), notes, preview total
- [ ] **B.5** PDF generation with `@react-pdf/renderer`:
  - Business logo + info header
  - Customer info
  - Surface breakdown table
  - Subtotal / tax / total
  - Customer "accept" link (signed URL, Phase 2 polish)
  - Payment terms
- [ ] **B.6** Send quote: upload PDF to Supabase Storage, email via Resend with link, mark `sent_at`
- [ ] **B.7** Quote list + detail views
- [ ] **B.8** E2E: full flow from "New Quote" to PDF email received (check via Resend API)

**Done when:**
- Can quote Will's own driveway end-to-end in <3 min
- PDF matches his expectations (weekly review with Will)
- Pricing engine unit tests at 100%
- Works on iPad Safari (field use)

#### Track C — Job Board

**Scope:** Kanban-style board for jobs in booked/in_progress/complete/cancelled.

**Owns:**
- `src/app/(dashboard)/jobs/*`
- `src/server/actions/jobs.ts`
- `src/lib/db/queries/jobs.ts`
- `src/components/features/job-board/*`
- `tests/unit/jobs.test.ts`
- `tests/e2e/jobs.spec.ts`

**Tasks:**
- [ ] Board view: 4 columns, drag-drop (use `@dnd-kit/core`)
- [ ] List view (alternate, mobile-friendly): filter by status
- [ ] Job detail: scheduled date, customer link, quote link (stub until 1C), notes, photos slot (stub until Track D), time log
- [ ] Status transitions log to `worklog_entries` automatically
- [ ] E2E: create job manually → drag to in_progress → complete

**Done when:**
- Drag-drop works on desktop + touch
- Status transitions logged
- Job list loads <500ms with 100 jobs seeded

#### Track D — Photo Upload

**Scope:** Upload photos attached to jobs, tagged before/after/progress.

**Owns:**
- `src/components/features/photo-upload/*`
- `src/server/actions/photos.ts`
- `src/lib/storage/*`
- `src/lib/db/queries/photos.ts`
- `tests/e2e/photos.spec.ts`

**Tasks:**
- [ ] Supabase Storage bucket `photos` with RLS matching DB
- [ ] Upload component: drag-drop + camera capture on mobile, resize client-side (max 2MB, 2048px)
- [ ] Gallery view on job detail page, tag selector
- [ ] Thumbnail generation via Supabase Image Transform
- [ ] Delete with confirmation
- [ ] E2E: upload → see in gallery → tag as before → delete

**Done when:**
- Upload works from iPhone camera (real device test)
- RLS verified: photos only accessible by tenant
- Storage path convention: `{tenant_id}/{job_id}/{photo_id}.{ext}`

#### Track E — Todos + Work Log

**Scope:** Dual-purpose "Inbox" view. Data model designed for MCP access in Phase 2.

**Owns:**
- `src/app/(dashboard)/inbox/*`
- `src/server/actions/todos.ts`
- `src/server/actions/worklog.ts`
- `src/lib/db/queries/todos.ts`
- `src/lib/db/queries/worklog.ts`
- `tests/e2e/inbox.spec.ts`

**Tasks:**
- [ ] Todos: create, complete, delete, optionally link to customer/quote/job/invoice
- [ ] Work log: free-form entries, timestamped, filterable by related_type
- [ ] Auto-entries from other modules: "Quote #42 sent to Smith", "Job #18 completed"
- [ ] Search across both (Postgres full-text)
- [ ] E2E: add todo → link to customer → complete → verify in work log

**Done when:**
- Search returns results in <200ms
- Auto-entries wired from quote-sent and job-status-change hooks
- Data model ready for MCP tools in Phase 2

---

### Phase 1C — Integration

#### Task 1C.1: Stripe Connect onboarding
**Files:** `src/app/(dashboard)/settings/payments/*`, `src/lib/stripe/*`, `src/app/api/stripe/webhook/route.ts`
**Steps:**
- [ ] Stripe Connect standard account creation server action
- [ ] Embedded onboarding via Stripe Connect embedded components
- [ ] Store `stripe_account_id` + `stripe_onboarded_at` on tenant
- [ ] Webhook handler for `account.updated` (onboarding complete)
- [ ] Settings page shows connection status
- [ ] E2E in Stripe test mode: complete onboarding, confirm tenant updated

#### Task 1C.2: Quote → Job conversion
- [ ] "Accept & Schedule" button on quote detail → creates job in `booked` status
- [ ] Quote status → `accepted`
- [ ] Auto work-log entry: "Quote #X converted to Job #Y"

#### Task 1C.3: Job → Invoice conversion
- [ ] On job completion, "Generate Invoice" button → creates invoice draft
- [ ] Invoice uses Stripe Invoicing API (destination charge on tenant's connected account, 0.5% application fee)
- [ ] Send invoice via Stripe → customer gets Stripe-hosted invoice with payment
- [ ] Webhook `invoice.paid` → updates DB, adds work-log entry
- [ ] E2E in Stripe test mode: complete job → invoice → pay with test card → confirm DB updated

#### Task 1C.4: "Will's full day" E2E
**The integration test that ties everything together:**
- [ ] Seed: Will's tenant + service catalog + 3 customers
- [ ] E2E script: log in → new quote for Smith → draw polygon → generate PDF → send → accept → schedule job → upload before photo → mark in progress → upload after photo → complete → generate invoice → (simulated) pay → verify work log shows 7+ entries
- [ ] Must pass headless in CI

**Done when:** One command, `pnpm test:e2e wills-day`, runs the full happy path against a clean test tenant and passes.

---

### Phase 1D — Hardening + Launch

#### Task 1D.1: Backup infrastructure
**Files:** `scripts/backup-now.ts`, `scripts/restore-test.ts`, `.github/workflows/nightly-backup.yml`
**Steps:**
- [ ] Supabase managed backups: confirm Pro plan enabled, 7-day PITR active
- [ ] Script: nightly `pg_dump` → encrypt (AES-256, key in GH secrets) → upload to AWS S3 (us-west-2)
- [ ] GitHub Actions cron: 03:00 UTC daily
- [ ] Restore script: downloads latest, decrypts, restores to local, runs smoke queries
- [ ] Document restore procedure in `RUNBOOK.md`
- [ ] Run full restore drill once, time it, document RTO
**Verify:** `pnpm backup:test-restore` successfully restores yesterday's backup to local staging DB. `SELECT COUNT(*) FROM customers` returns expected count.

#### Task 1D.2: Data export (PIPEDA)
**Files:** `src/app/(dashboard)/settings/export/*`, `src/server/actions/export.ts`
**Steps:**
- [ ] User clicks "Export all my data"
- [ ] Background job: ZIP of CSVs for every tenant-scoped table + photos
- [ ] Email signed download link, expires 7 days
- [ ] E2E: request export, receive email, download, verify contents

#### Task 1D.3: Observability
- [ ] Sentry: error tracking (free tier)
- [ ] PostHog or Plausible: product analytics
- [ ] Logdrain to Supabase logs or Axiom
- [ ] Uptime: UptimeRobot on `/api/health` endpoint

#### Task 1D.4: Launch checklist
- [ ] Load seed: Will's real service catalog (from §2.2 decision)
- [ ] Will signs up on prod, confirms everything renders
- [ ] Stripe Connect: Will completes onboarding on prod Stripe (live mode after verification)
- [ ] Will creates 3 real quotes for real customers
- [ ] Week of observation: daily check-ins, bug triage
- [ ] Acceptance call with Will: "would you pay $79/mo for this today?"

---

## 9. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Google Maps API costs spike | Low | Medium | $200/mo free credit; set billing alerts at $50/$100/$150 |
| Stripe Connect onboarding friction | Medium | High | Use embedded components, not redirect flow; test with Will on dev before prod |
| RLS policy hole leaks data | Low | Catastrophic | Every table has pgTAP negative test; security reviewer agent on every PR; no direct DB access in code outside `src/lib/db/` |
| Will loses interest mid-build | Low | Medium | Weekly demo keeps engagement; Phase 1C dogfood week is critical |
| Scope creep from JVD/John inputs | High | Medium | All renovation/tile features explicitly deferred to P2 in §1; say "yes, Phase 2" |
| Supabase outage during launch | Low | High | 4-layer backup strategy; restore drill documented; manual export available |
| Polygon drawing UX is confusing | Medium | High | Week 2 mid-track review with Will on iPad; 2 iterations baked into Track B timeline |

---

## 10. Definition of Done (Phase 1 Exit Criteria)

Phase 1 is DONE when ALL of these are true:
- [ ] Will has a paid Stripe Connect account attached to his tenant
- [ ] Will has sent 3 real quotes to real customers through the app
- [ ] At least 1 job has moved quoted → booked → complete → invoiced → paid
- [ ] Nightly backup has run 7 consecutive nights and one restore drill has passed
- [ ] All RLS policies have passing positive + negative pgTAP tests
- [ ] Playwright "Will's full day" E2E passes in CI
- [ ] No P0 or P1 bugs in backlog
- [ ] Will says: "I'd pay for this today." (recorded, with date)

---

## 11. Post-Launch Review

One week after Phase 1 launch:
- [ ] Retro with Jonathan: what worked, what didn't, what to change for Phase 2
- [ ] Metrics review: errors, response times, Will's usage frequency
- [ ] Brand name decision (if found)
- [ ] Phase 2 kickoff: JVD discovery deepens to requirements

---

## 12. Document Change Log

- 2026-04-15: Initial plan drafted.


---

## 13. Review Response & Revisions (2026-04-15)

First-pass reviewer flagged issues. Responses below amend the plan.

### 13.1 RLS hardening (P0 — fixes §7, Task 1.5)

**Change:** Do not trust `auth.jwt() ->> 'tenant_id'` alone. Tokens live ~1h; a removed member retains access until refresh. A missing type cast silently leaks.

**Revised approach:**
1. Add a `SECURITY DEFINER` SQL function:
   ```sql
   CREATE FUNCTION current_tenant_id() RETURNS uuid
   LANGUAGE sql STABLE SECURITY DEFINER AS $$
     SELECT tm.tenant_id FROM tenant_members tm
     WHERE tm.user_id = auth.uid()
     LIMIT 1;
   $$;
   ```
2. All RLS policies use `tenant_id = current_tenant_id()` (uuid = uuid, no cast).
3. `tenant_members` is the source of truth. Removing a member revokes access on next query, not on token refresh.
4. Add pgTAP test: insert member, remove member, confirm next query returns 0 rows within same session.
5. For multi-tenant users later (Phase 2), function returns `tenant_id` from a JWT claim that can be switched. Keep the function contract; change the body.

### 13.2 Stripe Connect: clarify merchant-of-record + tax (P0 — fixes Task 1C.1, 1C.3)

**Decisions required from Jonathan before Track C starts:**
- **Structure:** Use Stripe Connect **Standard** accounts, not Express or Custom. Will is merchant of record for his own invoices. We take an application fee on top, not a destination charge. This keeps tax liability on Will, not Smartfusion.
- **Corporate entity:** Jonathan accepts Stripe Connect platform ToS on behalf of a registered company, not personally. Confirm: does Smartfusion Industries Ltd exist? If not, incorporation is a prerequisite before going live.
- **BC tax:** Pressure washing (service, non-cleaning-of-goods) is GST 5% only in most cases, PST exempt. Materials (chemicals) may be PST-eligible if itemized separately. Default: Will's quotes show GST, PST row is hidden by default but available per line. Confirm with Will's accountant.
- **1099/T4A equivalents:** Stripe Connect handles most CRA reporting for Canadian connected accounts, but platform has reporting duties above $2,800 CAD/year per operator. Acceptable for a three-operator pilot; revisit at 10+ operators.
- **Refunds/disputes:** Connected account (Will) eats chargebacks. Application fee is refunded proportionally on full refund. Document this clearly in operator ToS.
- **ToS acceptance:** Track `stripe_tos_accepted_at` + `stripe_tos_version` on tenant row. Add to schema migration.

**New task 1C.1a:** Write operator ToS + privacy policy (use a template from a lawyer, Jonathan signs off).

### 13.3 PIPEDA checklist expanded (P0 — fixes Task 1D.2)

Export alone is one of eight duties. Full P1 compliance checklist:
- [ ] Privacy policy (plain language, what we collect, who we share with, retention, rights)
- [ ] Terms of Service for operators (Will is data controller, Smartfusion is processor)
- [ ] Data Processing Addendum (DPA) signed or deemed-signed with subprocessors: Supabase, Stripe, Google, Resend, Vercel, AWS
- [ ] Cookie consent banner (simple: essential-only, no tracking in P1)
- [ ] Account deletion flow (right to erasure, distinct from export)
- [ ] Breach notification procedure (docs + runbook in `RUNBOOK.md`, 72-hour target per BC PIPA)
- [ ] Data retention policy (tax records 7 years, customer data while tenant active, 90 days after deletion)
- [ ] Consent chain: operator ToS makes Will responsible for their customers' consent; Smartfusion ToS covers operator signup consent

New task **1D.2a:** Legal review pass. Budget: 2-3 hours with a Canadian SaaS lawyer.

### 13.4 Parallel tracks are semi-parallel (P0 — fixes §6)

Honest revision: tracks will need their own migrations.

**Revised protocol:**
- Foundation (1A) writes the *core* schema (tenants, tenant_members, RLS function, auth tables, 4-5 core tables that every track touches).
- Each track owns its own migration files with numbered prefixes in its track range:
  - Track A: 01xx
  - Track B: 02xx
  - Track C: 03xx
  - Track D: 04xx
  - Track E: 05xx
- Migration review is a hard blocker on PR merge; a lead reviewer (or a reviewer agent) checks that migrations don't collide.
- Schema for cross-track references (quote_id on jobs, job_id on invoices) is pre-declared in 1A as nullable FKs, filled in by integration phase.

Re-label §6: **"Independent feature tracks with coordinated schema migrations."** Not pure parallelism; realistic.

### 13.5 Missing prerequisites (P1 — fixes §2)

Add to §2.1:
- **Corporate entity** for Jonathan (Smartfusion Industries Ltd or similar) — prerequisite for Stripe Connect platform ToS. If not incorporated, add 1-2 weeks.
- **Business liability insurance** (errors and omissions, cyber) — you become a data processor the moment Will enters his first customer. $1-3M E&O policy, ~$600-1500/yr via a Canadian tech-friendly broker.
- **Bookkeeping setup** for SaaS fee revenue — QuickBooks or Wave account for Smartfusion's own books.
- **Trademark search** for final brand (USPTO + CIPO + domain availability) before rename.
- **Will's existing customer list** — CSV path: does he keep one? If in a notebook, add a 15-min data-entry session to 1D.4.

### 13.6 Testing gaps (P1 — amends §5)

**Stripe Connect real-mode testing:** test mode cannot simulate bank verification failures, KYC rejection, payout delays. Mitigation:
- Will's live Stripe Connect onboarding is the first real test. Budget a full afternoon.
- Before live: use Stripe CLI to trigger every webhook type against local dev.
- Document a rollback plan if onboarding fails (manual invoicing via Stripe dashboard until resolved).

**Google Maps testing:**
- **Domain-restrict the API key** the moment it is created (Google Cloud Console → Credentials → restrict to `app.smartfusion.ca`, `localhost:3000`, Vercel preview domains).
- Set billing alert at $50/$100/$150.
- E2E tests mock Maps JS. Polygon sqft calculation is tested against a fixed GeoJSON input, not live map.
- Visual regression tests skip the map area.

**RLS tests expand:**
- Anon role: can the unauthenticated public read any row? Must be 0 for every table except (eventually) public quote-accept URLs.
- Service role: where does it get used? Only in backup scripts and webhook handlers. Audit every `SUPABASE_SERVICE_ROLE_KEY` reference and confirm no user input reaches it.

### 13.7 Revised timeline (P1 — updates §6)

Realistic: **8-10 weeks**, not 5-7. Revised calendar:

```
Week 1-2:  Foundation (1A) — bigger because of legal + corp entity + RLS hardening
Week 3-6:  Parallel tracks (1B) — Track B (quoting) needs all 4 weeks
Week 7:    Integration (1C)
Week 8:    Hardening + backup drills (1D)
Week 9:    Will dogfood + bug fixes
Week 10:   Launch + acceptance
```

Stretch risks that could push to 12 weeks: corp entity delays, Stripe Connect onboarding edge cases, Google Maps mobile UX iterations.

### 13.8 Photo backup (P1 — adds to Task 1D.1)

Add to 1D.1:
- [ ] Supabase Storage → nightly S3 sync (`aws s3 sync`) — separate from pg_dump
- [ ] Include storage sync in restore drill (download, verify file integrity, spot-check image loads)

### 13.9 Smaller items (P2 — accepted, scheduled)

- Middleware auth verifies tenant_id claim exists (added to Task 1.6)
- Session invalidation on role change: via RLS function change (§13.1) this is automatic
- `audit_log` writes: added to integration phase (Task 1C, each state transition writes a row)
- Rate limiting: add Vercel Edge Config or Upstash rate limits on PDF generation, photo upload, login (new Task 1D.3a)
- Soft-delete: invoices, quotes, jobs, customers get `deleted_at TIMESTAMPTZ`. Added to schema revision.

### 13.10 Change log update

- 2026-04-15 (later): P0/P1 review responses appended. RLS hardened. Tax/MoR decisions captured. Timeline revised to 8-10 weeks.

