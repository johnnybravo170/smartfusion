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

Both use shadcn `AlertDialog`, wrap the action in a transition, handle `NEXT_REDIRECT`, and surface errors via toast.

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

Colored pill, one component per status enum. When you add a new status value to an enum, the badge needs the matching color.

- `src/components/features/projects/project-status-badge.tsx`
- `src/components/features/invoices/invoice-status-badge.tsx`
- `src/components/features/jobs/job-status-badge.tsx`
- `src/components/features/quotes/quote-status-badge.tsx`
- `src/components/features/change-orders/change-order-status-badge.tsx`
- `src/components/features/customers/customer-type-badge.tsx`
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
