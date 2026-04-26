# Patterns

Reusable UX/code patterns in this app. **Read this before building any new flow.** When you change one instance of a pattern, evaluate every sibling instance in the same family and surface them to the user for a "should I update these too?" decision — do not silently update siblings, and do not silently skip them.

If you introduce a new flow worth standardizing (or extract a one-off into a reusable component), add it here in the same turn.

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

## 11. CASL-classified sends

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

## 12. Plan / feature gating

All plan-tier checks go through `src/lib/billing/features.ts`. **Never write inline `if (tenant.plan === 'pro')` checks** — they drift and rot. Adding a gated feature is one line in `FEATURE_TIERS`.

- `src/lib/billing/features.ts` — `FEATURE_TIERS` catalog + `hasFeature` / `requireFeature` / `effectivePlan`. Single source of truth.
- `src/components/features/billing/locked-feature.tsx` — visible-but-locked placeholder with upgrade CTA. Use anywhere a gated feature would render.
- `src/components/features/billing/past-due-banner.tsx` — top-of-shell banner; rendered once in `(dashboard)/layout.tsx`.

Spec rule: gated features are **visible but locked**, never hidden. `past_due` and `unpaid` collapse the effective plan to `starter` at the gate (handled inside `effectivePlan` — call sites don't repeat this logic).
