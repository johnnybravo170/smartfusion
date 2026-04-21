# GC Quote-to-Invoice Workflow — Build Plan

**Date:** 2026-04-19 (last updated 2026-04-21)
**Vertical:** Renovation / General Contracting (JVD)
**Status:** Stages 1–6 UI complete end-to-end. Backlog items below remain.

## Decisions locked in (2026-04-21)

- **Milestone label default:** `Draw #N` (auto-increments from count of non-void, non-final invoices on the project). Free-form edit after.
- **Management fee:** displayed as a transparent line on both estimate-sourced invoices and the final invoice (not baked into totals).
- **BC 10% holdback:** skipped for v1. Revisit if JVD asks.
- **Residency:** every tenant has a `region` column (ca-central-1 today). All payment/tax code goes through `src/lib/providers/`. See `INFRA_RESIDENCY_PLAN.md` for the multi-region runbook.

---

## Schema foundation

All migrations applied (latest: 0063). See "Workflow stages — current state" below for what each table powers.

- `projects`, `project_cost_buckets`, `project_cost_lines` (+ `photo_storage_paths`, migration 0063)
- `cost_bucket_templates`
- `project_memos` (voice memo → transcript → AI extraction)
- `time_entries`, `expenses` (+ `receipt_storage_path`)
- `change_orders` (full approval state machine)
- `project_portal_updates` (+ `photo_storage_path`, migration 0062)
- `invoices.line_items` JSONB + `customer_note` + `payment_method` + `project_id`

---

## The GC workflow (vs pressure washing)

Pressure washing: **quote → job → single invoice**

GC/renovation: **estimate → project → [change orders] → [progress invoices] → final invoice**

Key differences:
- Estimates are **line-item / cost-bucket based**, not polygon area
- A quote converts to a **project**, not a job
- Projects run **weeks to months** with sub-milestones
- Invoicing is **milestone-based** (deposit, draws, holdback release, final) — not one invoice at job completion
- **Change orders** mutate the approved budget; they must be signed off before work proceeds
- **Management fee** (12% default) calculated on cost actuals, not just materials

---

## Workflow stages — current state

### Stage 1 — Estimate (Quote) ✅

- Line-item estimate UI at `/projects/[id]?tab=estimate` — cost lines with category, qty, unit cost/price, markup, notes, reference photos.
- Photos on cost lines: `project_cost_lines.photo_storage_paths` jsonb (migration 0063) + [CostLinePhotoStrip](src/components/features/projects/cost-line-photo-strip.tsx) + attach/remove actions.
- "Generate estimate from buckets" seeds cost lines from bucket estimates.
- "Send for approval" → emails customer a link to `/approve-estimate/[code]` (migration 0050 fields).
- "Create invoice from estimate" button on estimate tab → `createInvoiceFromEstimateAction` rolls up lines + adds management-fee line + 5% GST.

### Stage 2 — Project Creation (Quote → Project)

Quotes→projects in the pressure-washing sense (quote object) is still separate from GC estimates (cost-line form). JVD currently creates projects directly at `/projects/new`. Conversion from an accepted quote is **still a gap** — low priority since the GC flow starts at project creation today, but the cross-path would help operators who quoted via the legacy quote form.

Backlog:
- [ ] "Convert to project" action on accepted quote detail page — seed `project_cost_buckets` + optional portal.
- [ ] `cost_bucket_templates` management UI in Settings.

### Stage 3 — Active Project (Time, Expenses, Progress) ✅

- Time entries: `TimeForm` in [TimeExpenseTab](src/components/features/projects/time-expense-tab.tsx) → `logTimeAction`.
- Expenses with receipt upload: `ExpenseForm` → `logExpenseWithReceiptAction` (FormData variant) → private `receipts` bucket; project page signs URLs at render.
- Budget tracker: [BudgetSummaryCard](src/components/features/projects/budget-summary.tsx) shows totals **and** per-bucket breakdown (estimate / labour / expenses / actual / remaining, with over-budget highlight).
- Percent-complete slider: [PercentCompleteEditor](src/components/features/projects/percent-complete-editor.tsx) → `updateProjectAction`.
- Portal update composer: [PortalUpdateForm](src/components/features/portal/portal-update-form.tsx) posts progress/photo/milestone/message with optional photo upload to private `photos` bucket (`photo_storage_path` column, migration 0062); portal signs at render.

### Stage 4 — Change Orders ✅

- `ChangeOrderForm` at `/projects/[id]/change-orders/new` writes a draft via `createChangeOrderAction`, optionally chains `sendChangeOrderAction` to generate `approval_code` and email the customer.
- Public approval at `/approve/[code]`.
- Change order list + status badges on project detail.

### Stage 5 — Progress Invoicing (Milestone Draws) ✅

- "+ Milestone invoice" button on project's Invoices tab opens `MilestoneForm`.
- Label defaults to `Draw #N` (non-void, non-final invoice count + 1). Free-form edit.
- `createMilestoneInvoiceAction` inserts draft invoice with label in `customer_note` + line items + 5% GST.
- Post-creation: invoice detail page allows editing label ([InvoiceNote](src/components/features/invoices/invoice-note.tsx) → `updateInvoiceNoteAction`) and line items ([InvoiceLineItems](src/components/features/invoices/invoice-line-items.tsx) → `addInvoiceLineItemAction` / `removeInvoiceLineItemAction`). Both gated on `isDraft` — locked once sent/paid.
- Running total billed vs contract value still inferable from the list but not yet surfaced prominently; see backlog.

### Stage 6 — Final Invoice ✅

- "Generate final invoice" button on Invoices tab → `generateFinalInvoiceAction` reads all time_entries + expenses, applies `management_fee_rate` on the sum, subtracts prior non-void invoice amounts, produces a draft invoice with Labour / Materials & Expenses / Management Fee (transparent line) / Less: Prior Invoices.

Backlog:
- [ ] Final-invoice PDF template with project-name header + per-bucket cost breakdown.

---

## Build order (historical — all complete)

| Order | Track | Status |
|---|---|---|
| 1 | Estimate line-item mode + public approval | ✅ |
| 2 | Quote → Project conversion | ⏸ deferred (quotes/projects are parallel entry paths today) |
| 3A | Time + expense logging + receipt upload | ✅ |
| 3B | Change order creation + send | ✅ |
| 3C | Portal update composer + percent-complete + photo upload | ✅ |
| 4 | Budget tracker (estimate vs actual per bucket) | ✅ |
| 5 | Milestone invoice creation (Draw #N default) | ✅ |
| 6 | Final invoice generation | ✅ |

---

## Open decisions still pending

1. **Quote → Project conversion** — quotes and projects currently have parallel entry paths. Low priority; revisit if operators ask.
2. **Portal email cadence** — auto-notify homeowner on every portal update, or only when contractor explicitly triggers it? Today: manual trigger only.
3. **Billed-vs-contract surfacing** — running total is computable from the invoice list but no prominent "Billed so far: $X of $Y contract" header on Invoices tab. Ship when JVD asks.

---

## Backlog / future features

### Estimate-screen polish — closed 2026-04-21

- [x] "Generate estimate from buckets" → auto-switch to estimate tab after run.
- [x] Cost line description multi-line textarea (already a Textarea in current form).
- [x] Photos on cost lines — migration 0063, `photo_storage_paths` jsonb array, thumbnail strip in estimate tab.
- [x] Management fee auto-applied on estimate-sourced invoice (transparent line via `createInvoiceFromEstimateAction`).
- [x] "Create invoice from estimate" button on the estimate tab.

### Project name inline editing

Click the project name on the detail page to rename in-place. Add a small edit affordance on the project list row too (unobtrusive but discoverable). Single `updateProjectAction({id, name})`. **Status:** ProjectNameEditor already exists on the detail page — confirm it's wired before closing.

---

### Worker app / subcontractor experience (full plan)

JVD's "employees" are actually subcontractors, so the worker experience has to support both hourly employees and invoicing subs on a single surface. Owner-level toggles control what each worker sees. All workflows are mobile-first — the worker app is used from phones on jobsites.

#### 0. What exists today

- `tenant_members.role` supports `'owner' | 'admin' | 'member' | 'worker'` (migration 0028).
- `worker_invites` table (migration 0029) — single-use invite codes, already wired to `/join/[code]`.
- `time_entries` table has `user_id`, `project_id`, `bucket_id`, `job_id`, `hours`, `hourly_rate_cents`, `entry_date`.
- Settings > Team page lists members and issues invites.

Gaps: no worker profile fields (GST, business name, rates), no project assignments, no calendar, no worker-facing routes, no subcontractor invoice type, no nudge cron. Worker login today lands on the owner dashboard — wrong UX.

#### 1. Auth model

Reuse `tenant_members` with `role = 'worker'`. Add a `worker_profiles` table keyed 1:1 on `tenant_member_id` for the worker-specific fields (kept separate so it doesn't bloat `tenant_members` and so RLS on worker-only data can target the profile table).

Routing: any authenticated session where the user's role for the current tenant is `worker` redirects from `/dashboard`, `/projects`, `/customers`, etc. to `/w` (worker surface). Owners never land there. A single worker can be a `tenant_member` in only one tenant at a time for now (owners with multiple tenants already juggle that differently).

Middleware change: in `src/middleware.ts`, after tenant resolution, if `role === 'worker'` and the requested path isn't under `/w`, `/logout`, or the auth routes, redirect to `/w`.

#### 2. Schema (migration sketch)

```sql
-- 0051_worker_profiles_and_assignments.sql

-- Worker profile (1:1 with tenant_members where role='worker')
CREATE TABLE public.worker_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tenant_member_id UUID NOT NULL UNIQUE REFERENCES tenant_members(id) ON DELETE CASCADE,
  worker_type TEXT NOT NULL DEFAULT 'employee' CHECK (worker_type IN ('employee', 'subcontractor')),
  display_name TEXT,
  phone TEXT,
  -- Subcontractor billing details
  business_name TEXT,
  gst_number TEXT,
  address TEXT,
  default_hourly_rate_cents INTEGER,
  -- Per-worker capability overrides (NULL = inherit tenant default)
  can_log_expenses BOOLEAN,
  can_invoice BOOLEAN,
  -- Notification prefs
  nudge_email BOOLEAN NOT NULL DEFAULT TRUE,
  nudge_sms BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON public.worker_profiles (tenant_id);

-- Tenant-wide defaults
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS workers_can_log_expenses BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS workers_can_invoice_default BOOLEAN NOT NULL DEFAULT FALSE;

-- Assignments (worker attached to a project, optionally day-scheduled)
CREATE TABLE public.project_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  worker_profile_id UUID NOT NULL REFERENCES worker_profiles(id) ON DELETE CASCADE,
  -- For ongoing / "assigned to project in general" use NULL on the date window.
  -- For day-level scheduling use scheduled_date (one row per day-worker-project).
  scheduled_date DATE,
  hourly_rate_cents INTEGER,  -- override for this project; falls back to profile default
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, worker_profile_id, scheduled_date)  -- NULL scheduled_date allowed once
);
CREATE INDEX ON public.project_assignments (worker_profile_id, scheduled_date);
CREATE INDEX ON public.project_assignments (project_id);

-- Subcontractor invoices (worker → tenant, distinct from customer-facing invoices)
CREATE TABLE public.worker_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  worker_profile_id UUID NOT NULL REFERENCES worker_profiles(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  invoice_number TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'paid', 'rejected')),
  period_start DATE,
  period_end DATE,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  gst_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  line_items JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{description, qty, unit, rate_cents, total_cents}]
  notes TEXT,
  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  rejected_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON public.worker_invoices (tenant_id, status);
CREATE INDEX ON public.worker_invoices (worker_profile_id, status);
```

Expense logging reuses the existing `expenses` table (already has `project_id`, add `worker_profile_id UUID` if not present).

RLS: workers can read/write their own `worker_profiles` row, their assignments, their time_entries, their expenses (if tenant allows), their worker_invoices. Owners/admins see everything in their tenant.

#### 3. Route map

Worker surface is its own layout under `/w`:

```
/w                          → "today" dashboard (today's assignment + quick log)
/w/calendar                 → month/week calendar with assignment dots
/w/calendar?d=YYYY-MM-DD    → day view with time/expense entry
/w/projects                 → assigned-project list (active first)
/w/projects/[id]            → project details (scope the worker sees: label, address, buckets, notes)
/w/time                     → time-entry history
/w/time/new                 → add entry (pre-filled from ?d= and ?project=)
/w/expenses                 → expense list (if enabled)
/w/expenses/new             → add expense (photo + amount + project)
/w/invoices                 → subcontractor invoice list (if enabled)
/w/invoices/new             → build invoice from unbilled time entries
/w/invoices/[id]            → invoice detail + submit
/w/profile                  → edit display name, phone, GST/business info, nudge prefs
```

Owner-side additions:

```
/projects/[id]?tab=crew     → new tab: assign workers, schedule days, see who logged what
/settings/team              → (existing) now exposes per-worker toggles + worker_type selector
/settings/workers           → tenant-wide defaults for can_log_expenses / can_invoice
/invoices?view=worker       → approval queue for submitted worker_invoices
```

#### 4. Phased build

Each phase is shippable on its own.

**Phase W1 — Auth + worker shell + profile** *(~1 day)*
- Migration 0051 (worker_profiles + tenant defaults only).
- Middleware redirect: workers → `/w`.
- `/w` layout with bottom-nav (Today / Calendar / Projects / Profile).
- "Today" dashboard = your assigned projects for today (empty state if none).
- `/w/profile` with display name, phone, business_name, gst_number, default_hourly_rate, nudge prefs.
- Settings > Team: add `worker_type` selector, per-worker capability overrides.
- **Verify:** create a worker invite, accept it, land on `/w`, set GST, return.

**Phase W2 — Project assignments + assigned-projects list** *(~1 day)*
- Add `project_assignments` (from migration above — can split out if W1 shipped first).
- `/projects/[id]?tab=crew` owner view: pick worker, add/remove, set per-project hourly rate override.
- `/w/projects` — read-only list of projects where worker is assigned. Click through to `/w/projects/[id]` with scope + address + buckets + latest portal updates.
- **Verify:** owner assigns JVD's framer Dan to project "Smith reno"; Dan's phone shows it under `/w/projects`.

**Phase W3 — Time entry** *(~1 day)*
- Existing `time_entries` table — extend with `worker_profile_id` FK (nullable for legacy owner entries).
- `/w/time/new` — pre-fills project from `?project=` or today's assignment; bucket picker limited to the project's buckets; hours input; notes.
- `/w/time` — list grouped by week; swipe-delete within 24h of entry.
- Owner time tab (`/projects/[id]?tab=time`) — already exists; filter chip for "by worker".
- **Verify:** Dan taps "Log time" on Today, 6 hours on Framing bucket, sees it in history. JVD sees it on the project time tab tagged with Dan's name.

**Phase W4 — Day-level calendar + scheduling** *(~1.5 days)*
- Allow `project_assignments.scheduled_date` rows. Owner schedules Dan for Tue/Wed/Thu on "Smith reno".
- `/w/calendar` month view with dots; tap day opens day view with scheduled projects pre-listed and a "Log time" shortcut for each.
- Past days show what *was* logged; future days show what's *scheduled*.
- Owner crew tab gets a mini schedule grid (workers × next 14 days).
- **Verify:** JVD schedules Dan for 3 days; Dan sees them on his calendar; tapping Wed pre-fills the time entry form with that project.

**Phase W5 — Expense logging** *(~1 day, gated)*
- `expenses` table already exists. Add `worker_profile_id` + `receipt_photo_url`.
- `/w/expenses/new` — camera capture of receipt → Supabase Storage → amount + project + vendor fields.
- List + per-expense approval status on owner side (new `status` column or reuse existing approval pattern).
- Gate entire `/w/expenses/*` surface on `worker_profile.can_log_expenses ?? tenant.workers_can_log_expenses`.
- **Verify:** Dan logs a $42 hardware store receipt with photo; JVD sees it on the expenses tab with the receipt thumbnail.

**Phase W6 — Subcontractor invoicing** *(~2 days, gated)*
- Migration adds `worker_invoices` table.
- `/w/invoices/new` — select unbilled time entries + expenses (date-range or checkboxes); auto-compute subtotal (hours × rate) + GST; editable notes; save draft → submit.
- Owner inbox `/invoices?view=worker` — list submitted; approve / reject / mark paid. Approved invoices can optionally roll through to the project's cost tab.
- Email to owner on submit; email to worker on approval/rejection.
- Gate on `worker_profile.can_invoice ?? tenant.workers_can_invoice_default`. Default: off for `employee`, on for `subcontractor`.
- **Verify:** Dan (subcontractor) builds an invoice for Mon–Fri on Smith reno, $480 + GST; submits; JVD gets email; approves; Dan gets confirmation.

**Phase W7 — 7pm nudge cron** *(~0.5 day)*
- New route `/api/workers/time-nudge` (same CRON_SECRET pattern as estimate-nudge).
- Schedule in `vercel.json`: `0 19 * * *` in America/Edmonton (Vercel crons are UTC, so convert — likely `0 1 * * *` UTC during MDT).
- Query: workers who had a `project_assignments` scheduled_date = today AND no `time_entries` for today.
- Send email (and SMS if `nudge_sms` on) via existing Resend / Twilio plumbing.
- **Verify:** manually insert an assignment for today, delete any time entries, hit the route with the bearer token, confirm email arrives.

#### 5. Owner controls summary

| Control | Location | Scope | Default |
|--|--|--|--|
| `worker_type` | Settings > Team per-member | per worker | `employee` |
| `can_log_expenses` | Settings > Team per-member | per worker (overrides tenant) | inherit |
| `can_invoice` | Settings > Team per-member | per worker (overrides tenant) | inherit |
| `workers_can_log_expenses` | Settings > Workers | tenant | `true` |
| `workers_can_invoice_default` | Settings > Workers | tenant | `false` |
| hourly rate (default) | Settings > Team per-member → opens worker profile | per worker | null |
| hourly rate (project override) | Project > Crew tab | per assignment | falls back |
| assignment (project-level) | Project > Crew tab | per project | — |
| assignment (day-level) | Project > Crew tab mini grid | per day | — |

#### 6. Open questions to resolve before starting

1. **SMS.** Twilio plumbing exists (`src/app/api/twilio/webhook`). Worker-side SMS nudges — is JVD paying for Twilio already? If not, phase W7 ships email-only and SMS follows later.
2. **Multi-tenant workers.** A tradesperson who subs for two different GCs on HeyHenry. Out of scope for v1 (single tenant per worker).
3. **Worker-facing copy: "subcontractor" vs just "worker".** Hide the distinction from Dan entirely; he just sees "Time", "Invoices" (if on), etc. The `worker_type` lives only in the owner's settings.
4. **Invoice approval → cost-line sync.** Should an approved worker invoice auto-create cost lines in the right bucket, or just hit the variance tab? Recommend: auto-create `project_cost_lines` tagged as `source='worker_invoice'` with a back-reference, so variance reporting sees real labour cost without double-entry.
5. **Time entry correction window.** 24h self-edit, then only owner can adjust? Or no window at all? Recommend 24h self-edit so Dan can fix typos on the ride home but can't retroactively pad a week after payroll.

---

---

### Project file attachments (drawings, specs, etc.)

Lightweight upload + archive for non-photo files: plans, architectural drawings, permits, spec sheets, vendor warranty docs. Storage + list + download only for now (no parsing, no AI). Adds a "Files" tab on the project page. Supabase Storage bucket `project-files/{tenant_id}/{project_id}/{uuid}-{filename}`, new `project_files` table (id, project_id, filename, storage_path, size, mime_type, uploaded_by, uploaded_at, deleted_at). Signed download URLs.

---

### Customer closeout package (ZIP)

At job completion, generate a downloadable ZIP the contractor can hand to the homeowner containing:

- Jobsite photos (tenant-selectable — before/after/progress subset, not the full dump).
- Material + colour reference sheet: paint codes, tile SKUs, grout colour, flooring model #s, hardware finishes, appliance model/serial, etc. Sourced from cost-line metadata and/or a new "spec sheet" field on cost lines or buckets.
- Optional: warranty docs, care instructions, final invoice PDF, change order summary.

Triggered from the project page once status is `completed`. ZIP is built server-side and either downloaded directly or emailed via the portal.

Open questions:
- Where do colour/material codes live today? Currently freeform in cost-line descriptions — likely need structured fields (`spec_code`, `spec_label`, `supplier`) on cost lines or a separate `project_specs` table.
- Tenant photo selection UI — reuse the existing gallery with a multi-select + "Include in closeout" toggle?
- Delivery: direct download vs homeowner portal vs emailed link?

---

## Source research (vault)

- `Renovation Vertical — Competitive Analysis + Remodeler Pain Points (April 2026)` — 6 pain clusters, competitor gaps, what to build
- `Contractor OS Architecture Plan` — modules list for renovation vertical
- `SPEC-v1.md` — JVD's specific requests (walk-and-record voice memo → quote draft, biweekly budget reports)
- `HeyHenry UX Principles` — edit where you look, no login walls for customers, preview before send
