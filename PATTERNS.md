# Patterns

Reusable UX/code patterns in this app. **Read this before building any new flow.** When you change one instance of a pattern, evaluate every sibling instance in the same family and surface them to the user for a "should I update these too?" decision — do not silently update siblings, and do not silently skip them.

If you introduce a new flow worth standardizing (or extract a one-off into a reusable component), add it here in the same turn.

> **Naming conventions** — for term-level rules (especially "budget category" vs "storage bucket"), see [NAMING.md](./NAMING.md).

---

## 1. File / image upload zones

When you change upload behavior (file size limits, accepted types, drag-drop, optimistic preview, click target on the placeholder, progress UI, error toasts, EXIF stripping, resizing), check every sibling and ask before touching them.

- `src/components/features/photos/photo-upload.tsx` — drag-drop + click + mobile camera; client-side resize; FormData → server action.
- `src/components/features/memos/memo-upload.tsx` — voice memo (MediaRecorder or file); transcription queue; can bundle staged photos.
- `src/components/features/settings/logo-uploader.tsx` — single-file picker; optimistic preview; placeholder square is itself a click target.
- `src/components/features/contacts/intake-dropzone.tsx` — reusable drag-drop + click dropzone used by the contact-intake form (non-customer) and the lead-intake form (customer). File-shape-agnostic; parent owns the file[] state and decides what to do with it (resize images, parse vCards, etc).

**Shared expectations:** all four use the `{ ok, error }` server-action discriminant, all show toast errors, all do optimistic preview where the file is visual. Drag-over state uses `border-primary bg-primary/5` — see photo-upload and intake-dropzone for the canonical styling.

---

## 2. Customer picker / pick-or-create

Anywhere a user selects a customer **must** allow inline-create. Don't drop the user into a separate page.

- `src/components/features/customers/customer-picker.tsx` — base searchable combobox (Command + Popover).
- `src/components/features/customers/customer-picker-with-create.tsx` — wraps the picker with the inline "New customer" form. **Use this**, not the bare picker, in any new flow that needs pick-or-create.

Used by: new-project form, clone-project dialog. Add new callers here.

---

## 3. Confirm / destructive action dialogs

Soft-delete confirmations follow one shape. When you change the wording, button colors, or post-delete navigation in one, evaluate the others.

- `src/components/features/customers/delete-customer-button.tsx`
- `src/components/features/projects/delete-project-button.tsx`
- `src/components/features/billing/cancel-subscription-button.tsx` — async preview-on-open variant; shows the prorated refund amount + access end date inside the dialog before the destructive button is enabled. No "are you sure / why are you leaving" upsell — locked policy.

All three use shadcn `AlertDialog`, wrap the action in a transition, and surface errors via toast. Delete variants additionally handle `NEXT_REDIRECT`.

---

## 4. Inline edit fields (click-to-edit)

Click-to-edit fields use the same keyboard contract: Enter saves, Escape cancels, blur saves. When you change keyboard handling or hover affordance in one, check the others.

- `src/components/features/projects/project-name-editor.tsx` — heading + inline variants.
- `src/components/features/projects/percent-complete-editor.tsx` — slider variant; shows "edit" hint on hover.
- `src/components/features/projects/management-fee-editor.tsx` — number-as-percent variant on the Overview facts grid; writes a worklog entry on change.

---

## 5. Server-action result handling

Every server action returns `{ ok: true; id: string } | { ok: false; error: string; fieldErrors?: Record<string,string[]> }`. Components branch on `result.ok` and surface `result.error` via `toast.error`. Field-level errors are mapped onto the form via `form.setError`.

If you add a new server action, follow this shape — don't throw from the action for expected errors.

---

## 6. Empty states

Standard shape: icon + headline + 1-line description + primary CTA. Some have a "fresh" vs "filtered" variant — when the variant set changes in one, consider whether the others should match.

- `src/components/features/customers/customer-empty-state.tsx` — fresh / filtered.
- `src/components/features/jobs/job-empty-state.tsx` — fresh / filtered.
- `src/components/features/quotes/quote-empty-state.tsx` — fresh / filtered.
- `src/components/features/invoices/invoice-empty-state.tsx` — single.
- `src/components/features/inbox/todo-empty-state.tsx` — single.

---

## 7. Status badges

Colored pill, one component per status enum. **All color classes are centralized in `src/lib/ui/status-tokens.ts`.** That file maps each status value to a `StatusTone` (`neutral | info | warning | success | danger | hold`), and each tone to a full Tailwind class string. Badge components import the maps and tone-class table — they do NOT declare colors inline.

When you add a new status value to an enum, update the matching `*StatusTone` map in `status-tokens.ts`, **not** the badge component. When you render a status anywhere other than through a badge component (dashboard tile, detail page, etc.), import the tone and class from `status-tokens.ts` — do not hand-roll a color for the same meaning.

- `src/lib/ui/status-tokens.ts` — **source of truth for every status color**
- `src/components/features/projects/project-status-badge.tsx`
- `src/components/features/invoices/invoice-status-badge.tsx`
- `src/components/features/jobs/job-status-badge.tsx`
- `src/components/features/quotes/quote-status-badge.tsx`
- `src/components/features/change-orders/change-order-status-badge.tsx`
- `src/components/features/customers/customer-type-badge.tsx` — kind colors (customer/lead/vendor/sub/etc.) — separate palette from status tones by design
- `src/components/features/inbox/worklog-entry-type-badge.tsx`
- `src/components/features/worker/worker-invoice-status-badge.tsx`

---

## 8. Calendar / schedule grids

Two grid surfaces today, both built on `project_assignments`. **Forked on purpose** — the per-project view is drag-heavy, the owner view is click-to-modal. Once the owner view stabilizes, evaluate extracting a shared core (date math, weekend handling, project-color hash).

- `src/components/features/projects/crew-schedule-grid.tsx` — per-project drag-to-schedule grid (rows = workers).
- `src/components/features/calendar/owner-calendar.tsx` — tenant-wide month + 14-day views (rows = projects in 14-day; calendar cells in month).
- `src/components/features/jobs/job-calendar.tsx` — month grid for jobs only.

Shared concerns to keep aligned: weekend dimming, `isToday` highlight, project color hash, ISO date helpers (`parseIso`/`isoDate`).

---

## 9. Tabs / sub-navigation

URL-param driven (`?tab=estimate`); `router.replace()` to avoid history pollution; mobile uses a native `<select>` rather than horizontal scroll.

- `src/components/features/inbox/inbox-tabs.tsx`
- `src/components/features/projects/project-tab-select.tsx` (mobile select)
- The project detail page renders a row of `<Link>` tabs above `lg`, the select below it.
- `src/components/features/tasks/job-tabs.tsx` — distinct-route variant on the job detail page (`/jobs/[id]` vs `/jobs/[id]/tasks`). Used when each tab needs its own server component shell rather than re-rendering off a query param.

---

## 10. Task module (status palette + inline edit + filters)

The Tasks module ships its own status palette (8 values, including orange/purple/teal that don't appear elsewhere). When you add a new status value or render a task chip outside the badge component, update **both** sides:

- `src/lib/ui/status-tokens.ts` — `taskStatusClass` map (per-status Tailwind classes; not a StatusTone — task chips use a richer palette)
- `src/lib/validators/task.ts` — `taskStatuses` enum + `taskStatusLabels` map + matching server-side check constraint in `supabase/migrations/0118_tasks.sql`
- `src/components/features/tasks/task-status-badge.tsx` — read-only badge
- `src/components/features/tasks/task-status-pill.tsx` — interactive Select-as-pill (used for inline status changes)

Sibling instances to keep aligned when the task list UX changes:

- `src/components/features/tasks/project-task-list.tsx` — phase-grouped, filter chips, owner-only Verify button next to `done` rows
- `src/components/features/tasks/lead-tasks-section.tsx` — lead-scope variant (no phases, no job); rows auto-migrate to project scope when a job is created for the lead (see `createJobAction`)
- `src/components/features/worker/worker-task-list.tsx` — mobile worker list; big-tap Done / Blocked / Need Help / Add Photo buttons; `blocked` requires a reason
- `src/app/(dashboard)/todos/page.tsx` — flat personal list, checkbox-style toggle
- `src/components/features/dashboard/command-center.tsx` — read-only Today/Blocked/Needs You buckets; Needs You includes a "To Verify" subsection (owner-only inline Verify / Reject per row)

Inline-edit follows §4's keyboard contract (Enter saves, Escape cancels, blur saves).

---

## 11. Cross-tenant RLS test (every new tenant-scoped table)

Every table protected by RLS must have a cross-tenant isolation test. We
run a single comprehensive runner that provisions tenants A and B,
authenticates as A, and runs five assertions per table:

1. SELECT does not return B's row
2. Targeted lookup of B's row returns null
3. UPDATE on B's row affects zero rows
4. DELETE on B's row affects zero rows
5. Cross-tenant INSERT (with B's tenant_id) is rejected by WITH CHECK

- `tests/integration/cross-tenant-rls.test.ts` — the runner. Add new tables
  by appending to `RLS_TABLE_CASES`. See the comment block at the top for
  the entry shape (table name, seed function, update payload, optional
  insert-rejection payload). The same file also contains an
  `'active-membership scoping (multi-tenant user)'` block that proves
  `current_tenant_id()` honors the active flag — one user with two
  memberships sees only the active tenant's data, switching via the
  `set_active_tenant_member` RPC swaps visibility, and the RPC rejects
  switches to tenants the caller doesn't belong to.
- `tests/integration/customers-rls.test.ts` — older single-table version,
  kept for reference; the comprehensive runner above covers customers too.

When you `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` in a migration, you
**must** add an entry to the runner in the same PR. CI catches missing
isolation but only for tables you've registered.

---

## 12. CASL-classified sends

Every outbound email and SMS goes through one of two wrappers, and **every
call must declare a `caslCategory`**. See `CASL.md` for the rulebook. When
you change one send path (template, evidence shape, related type), evaluate
sibling sends in the same family and surface them to the user.

- `src/lib/email/send.ts` — `sendEmail` wrapper. Logs every send to
  `email_send_log`. Required: `caslCategory`. Optional: `caslEvidence`,
  `relatedType`, `relatedId`.
- `src/lib/twilio/client.ts` — `sendSms` wrapper. Logs to `twilio_messages`.
  Same contract.
- `src/lib/ar/executor.ts` — AR engine. Only legitimate caller for CEM
  categories (`express_consent`, `implied_consent_*`). Handles RFC 8058
  unsubscribe + suppression list automatically.

Send-path families to keep aligned when CASL evidence shape changes:

- **Estimate flow** — `src/server/actions/estimate-approval.ts` (4 sends),
  `src/server/actions/quotes.ts` (3 sends)
- **Change order flow** — `src/server/actions/change-orders.ts` (email + SMS
  + internal notify)
- **Invoice flow** — `src/server/actions/invoices.ts` (2 sends)
- **Job lifecycle** — `src/server/actions/jobs.ts`,
  `src/server/actions/project-phases.ts`, `src/server/actions/pulse.ts`,
  `src/server/actions/portal-updates.ts`
- **Account / auth** — `src/server/actions/auth.ts`,
  `src/server/actions/onboarding-verification.ts`,
  `src/server/actions/team.ts`, `src/server/actions/billing.ts`
- **Lead intake** — `src/server/actions/lead-gen.ts`,
  `src/server/actions/referrals.ts`
- **Marketing** — `src/lib/ar/executor.ts` (express_consent only)

Never bolt promotional content onto a transactional template — that flips
the send into CEM territory and loses the transactional exemption.

---

## 13. Plan / feature gating

All plan-tier checks go through `src/lib/billing/features.ts`. **Never write inline `if (tenant.plan === 'pro')` checks** — they drift and rot. Adding a gated feature is one line in `FEATURE_TIERS`.

- `src/lib/billing/features.ts` — `FEATURE_TIERS` catalog + `hasFeature` / `requireFeature` / `effectivePlan`. Single source of truth.
- `src/components/features/billing/locked-feature.tsx` — visible-but-locked placeholder with upgrade CTA. Use anywhere a gated feature would render.
- `src/components/features/billing/past-due-banner.tsx` — top-of-shell banner; rendered once in `(dashboard)/layout.tsx`.

Spec rule: gated features are **visible but locked**, never hidden. `past_due` and `unpaid` collapse the effective plan to `starter` at the gate (handled inside `effectivePlan` — call sites don't repeat this logic).

---

## 14. Per-project team checklist (parallel to tasks)

The `project_checklist_items` table is a deliberately lightweight, collaborative-by-default surface for field-level notes ("need 2 pancake boxes for the electrical panel"). It sits next to the heavier `tasks` table — tasks owns PM-level workflow (statuses, assignees, verification, photo requirements); the checklist owns crew-level "stuff we need" notes.

When a feature blurs the line between the two, ask: does this need an assignee, a status beyond done/not-done, or verification? If yes, it's a task. If it's just a checkbox somebody on site jotted down, it's a checklist item.

- `src/lib/db/schema/project-checklist-items.ts` — schema. RLS is open within the tenant (any member can CRUD).
- `src/server/actions/project-checklist.ts` — add / toggle / rename / attach-photo / remove-photo / delete / set-hide-window.
- `src/lib/db/queries/project-checklist.ts` — list-for-project (applies hide window), distinct categories per project, tenant-wide rollup, last-billed-project lookup.
- `src/lib/storage/project-checklist.ts` — separate `project-checklist` storage bucket so ephemeral field snapshots don't pollute the main photo gallery.
- `src/components/features/checklist/team-checklist.tsx` — server entry. Pre-signs photo URLs.
- `src/components/features/checklist/team-checklist-client.tsx` — interactive surface with optimistic state. `chrome="card"` (default) wraps in a titled Card; `chrome="bare"` renders just the add row + list when the host page already supplies title + chrome.
- `src/components/features/checklist/site-switcher.tsx` — popover used on the worker dashboard to switch between assigned projects when the auto-default isn't right.

The hide-completed-after-N-hours setting lives in `tenant_prefs(namespace='checklist').data.hide_completed_after_hours` — `null` means never hide. Default 48h on first read.

Photo lifecycle: attachments are auto-expired ~90 days after the parent project's `completed_at` by a scheduled task (separate concern; the table just stores the path).

---

## 15. Duplicate-detection dialogs

When a server action returns a `{ duplicate: { existing_id, vendor, amount_cents, expense_date } }` shape (overhead expenses today, possibly other entities later), every caller renders the same shared dialog so the user gets a consistent View existing / Cancel / Save anyway flow regardless of entry point.

- `src/components/features/expenses/duplicate-expense-dialog.tsx` — shared dialog component. Props: `duplicate`, `onClose`, `onForceSave`, `busy`.
- `src/components/features/expenses/overhead-expense-form.tsx` — full overhead form caller.
- `src/components/layout/quick-log-expense-button.tsx` — top-bar quick-log caller.

When you add a new caller (or extend the duplicate-detection rule to a new entity type), surface the existing callers and ask the user before changing the dialog's contract. Don't degrade one caller's UX (e.g. swap the dialog for a toast) without explicit decision — that's exactly the bug this pattern was extracted to fix.

---

## 16. AI-assisted entity import (Henry-powered onboarding)

Bringing existing data into the app — customers today, projects/invoices/expenses later — uses a single recipe:

1. **Operator drops a file or pastes text.** The dropzone reuses §1's `intake-dropzone` (file-shape-agnostic) plus a paste textarea. Either input is accepted; the operator picks whichever feels easiest.
2. **Henry classifies via the gateway.** A schema-driven `gateway().runStructured()` call with task `onboarding_<entity>_classify` turns whatever shape came in into a typed proposal array. **Pinned to high-quality models** (Sonnet 4.6, no tier-climb secondary) — this is a Day-1 first-impression moment, cost is irrelevant, sloppy classification undermines the entire product.
3. **Deterministic dedup runs server-side.** AI proposes; deterministic logic decides what's a match. See `src/lib/customers/dedup.ts` for the customer tier system (email > phone > name+city > name). Add a sibling file under `src/lib/<entity>/dedup.ts` for each new entity type.
4. **Preview is ephemeral.** No staging table — the proposal array is round-tripped through the client and edited in place. Operator chooses Create / Merge / Skip per row, optionally edits any field, optionally adds an audit note.
5. **Commit writes an `import_batch` row + tags every created entity with `import_batch_id`.** This gives provenance and rollback. See migration `0185_import_batches.sql` and the matching FK column on customers. New entity phases (projects / invoices / expenses) MUST add their own `import_batch_id` FK in the same shape — don't invent a parallel mechanism.
6. **Rollback is admin-grade and always available.** `rollbackCustomerImportAction(batchId)` soft-deletes via `deleted_at` (NOT hard delete; the records may already be referenced) and stamps the batch row's `rolled_back_at`. Surface a "rolled back" indicator anywhere a tagged row appears.

**Non-negotiables when extending to projects/invoices/expenses:**

- Reuse the `gateway().runStructured()` pattern — never bypass it for "simpler" provider calls.
- Reuse the deterministic dedup contract (return `{ tier, existingId, existingName }`) so the wizard UI is generic across entity types.
- Money + tax math on imported invoices must FREEZE at the rate effective on the historical date, not recompute at today's rate. The customer-facing tax helper in `src/lib/providers/tax/canadian.ts` accepts an explicit override for exactly this case.
- Cross-entity FKs (invoice.customer_id resolved from the customer phase): commit phases in topological order — customers first, then projects, then invoices.

**Cross-entity FK resolution (Phase B onward):**

When an entity references another (e.g. project → customer, invoice → customer + project), the wizard surfaces a per-row resolution column showing whether the reference matched an existing row, will create a new row, or is unattached. Defaults: matched if a strong dedup tier hit; create-new with the reference's name otherwise. The commit pipeline creates the side-effect rows FIRST (tagged with the SAME batch_id) so the FKs land cleanly, then inserts the primary entity rows. Rollback removes the side-effect rows too — this preserves "rollback removes everything from that operation" without forcing a multi-step UX.

**Frozen money math (Phase C onward):**

Imported invoices freeze their `amount_cents` and `tax_cents` exactly as the source recorded — NEVER recompute against today's customer-facing rate. The `import_batch_id IS NOT NULL` flag is the contract that downstream code must check. Same rule applies to historical management-fee rates on imported estimates when Phase C+ extends scope. Code that re-derives money from a different source (e.g. tax provider) MUST skip imported rows.

**Volume / timeout / size:**

Server-action body cap is 50MB framework-wide ([next.config.ts](next.config.ts)). Per-import-action cap is 25MB for text-shaped imports (A/B/C), 10MB per file for receipts (D — matches the live single-receipt flow). LLM input slice is 800K chars (~200K tokens) on text imports. Each import page sets `export const maxDuration = 300` so server actions get 5 minutes on Vercel. Very large files (10K+ rows) need chunking; not implemented yet — kanban entry tracks the gap.

**File-shaped inputs (Phase D onward):**

Receipts and other file-pile imports don't fit the single-shot text recipe — OCR per file is 5–15s, so a 50-receipt batch in one server action would blow past `maxDuration`. The pattern is **client-side fan-out**: the wizard iterates over the dropped files and calls a single-file parse action per receipt, building the preview list with progress UI as results arrive. The commit action takes the aggregated preview state and bulk-inserts in one call. Failed parses don't fail the batch — they render as red rows the operator can either retry, fill in manually, or skip.

Files in this family today:

- `supabase/migrations/0185_import_batches.sql` — `import_batches` table + storage bucket
- `supabase/migrations/0186_projects_import_batch.sql` — `projects.import_batch_id`
- `supabase/migrations/0187_invoices_import_batch.sql` — `invoices.import_batch_id` (frozen-math contract)
- `supabase/migrations/0188_expenses_import_batch.sql` — `expenses.import_batch_id` (frozen-math contract)
- `src/lib/customers/dedup.ts` / `src/lib/projects/dedup.ts` / `src/lib/invoices/dedup.ts` / `src/lib/expenses/dedup.ts` — per-entity dedup engines
- `src/lib/ai-gateway/{tasks,routing}.ts` — `onboarding_customer_classify`, `onboarding_project_classify`, `onboarding_invoice_classify` tasks (all pinned to Sonnet 4.6, no tier-climb). Phase D reuses `receipt_ocr` (Gemini-primary) per-file.
- `src/server/actions/onboarding-import.ts` — Phase A (customers) actions
- `src/server/actions/onboarding-import-projects.ts` — Phase B (projects + side-effect customers) actions
- `src/server/actions/onboarding-import-invoices.ts` — Phase C (invoices + side-effect projects + side-effect customers; frozen money math)
- `src/server/actions/onboarding-import-receipts.ts` — Phase D (one-file-at-a-time OCR + bulk-insert expenses)
- `src/components/features/onboarding/customer-import-wizard.tsx` — Phase A wizard
- `src/components/features/onboarding/project-import-wizard.tsx` — Phase B wizard
- `src/components/features/onboarding/invoice-import-wizard.tsx` — Phase C wizard (with editable money cells)
- `src/components/features/onboarding/receipt-import-wizard.tsx` — Phase D wizard (multi-file fan-out + per-file progress)
- `src/components/features/onboarding/imports-list.tsx` — `/settings/imports` rollback list (per-kind dispatch across all four phases)
- `src/app/(dashboard)/contacts/import/page.tsx` + `/projects/import/page.tsx` + `/invoices/import/page.tsx` + `/expenses/import/page.tsx` — entry routes (each with `maxDuration = 300`)

All four phases of the kanban card "Henry-powered onboarding import wizard" are wired. Open follow-up: chunked classification for very large text imports (10K+ rows in one paste), and dogfooding with real customer data.

---

## 17. Mobile width: grid + truncate min-width gotchas

Two tightly-related Tailwind/CSS pitfalls that can silently push a layout past the iPhone viewport. Both surfaced together while chasing a "dashboard too wide" bug — neither showed up under static inspection or with `overflow-x-hidden` on `<main>` (that just clipped the visual; the layout had already escaped).

### Rule A — Always set `grid-cols-1` on the base breakpoint when the larger breakpoint sets columns

```tsx
// WRONG — at mobile, grid-template-columns falls back to `none`,
// implicit columns size to grid-auto-columns: auto = max-content.
// Each grid item grows to fit its widest descendant's intrinsic width.
<div className="grid gap-4 md:grid-cols-3">

// RIGHT — explicit grid-cols-1 = repeat(1, minmax(0, 1fr)),
// constraining the column track to the container width.
<div className="grid grid-cols-1 gap-4 md:grid-cols-3">
```

### Rule B — Grid items default to `min-width: auto`, just like flex items

`grid-cols-1` (= `minmax(0, 1fr)`) sets the column track's *minimum* to 0, but the item inside still defaults to `min-width: auto = min-content`. With `truncate` (which sets `white-space: nowrap`) anywhere in the subtree, min-content propagates up to the full nowrap text width — the item then overflows the column track.

`min-w-0` on the grid item is the symmetric counterpart to the flex `min-w-0` trick:

```tsx
// Card grid:
<div className="grid grid-cols-1 gap-4 md:grid-cols-3">
  <section className="min-w-0 rounded-xl border bg-card p-4">
    {/* truncate-laden content here is now safe */}
  </section>
</div>

// Flex row with truncating child:
<div className="flex items-center gap-3">
  <Link className="min-w-0 flex-1 truncate">{title}</Link>
  <Badge className="shrink-0" />
</div>
```

### Quick checklist when a row / card looks "too wide on mobile"

1. Does the wrapping grid have `grid-cols-N` set at the **base** breakpoint? If only `md:`/`sm:` is set, add `grid-cols-1`.
2. Does the grid **item** have `min-w-0`? Required when descendants use `truncate`, `whitespace-nowrap`, or other nowrap text.
3. Does each `flex-1 truncate` element also have `min-w-0` on the same node? Required for truncate to actually constrain in a flex row.
4. Are there hover-only UI elements (`opacity-0 group-hover:opacity-100`, hover-revealed buttons) reserving width on touch devices? Hide on mobile (`hidden md:inline-flex`) — touch has no hover.
5. If static inspection fails, drop in a temporary client-side runtime probe rather than guessing. Walk the DOM, find elements where `rect.right > nearestClippingAncestor.right`, render the top offenders as a fixed banner. Display **everything**; trust the user's eyes; remove the probe in the same commit as the fix.

### Files this pattern was applied to

- `src/components/features/dashboard/command-center.tsx` — outer grid + each Card section + Job Health inner ul
- `src/components/features/dashboard/key-metrics.tsx`
- `src/components/features/dashboard/pipeline-summary.tsx`
- `src/components/features/dashboard/renovation-pipeline-summary.tsx`
- `src/components/features/dashboard/recent-activity.tsx` — flex truncate min-w-0
- `src/components/features/dashboard/money-at-risk-card.tsx` — break-all on phone/email
- `src/components/features/tasks/task-row.tsx` — hover-only Delete button hidden on mobile
- `src/components/layout/workspace-switcher.tsx`, settings/calendar-feed-card, settings/public-quote-link-card, portal/portal-toggle, calendar/assign-workers-dialog, calendar/owner-calendar, expenses/overhead-expense-form, projects/estimate-tab, team/invite-worker-card, team/invite-bookkeeper-card — all `flex-1 truncate` rows that needed `min-w-0`.
