# Portal Phases — Generic seed, per-project editing, deferred notify

**Status:** DRAFT 2026-05-06. Awaiting approval.
**Date:** 2026-05-06
**Author:** Claude + Jonathan

## Problem

Two issues surfaced from John's first real walkthrough of the customer portal with a homeowner:

1. **SMS spam on rapid advance.** John clicked the **Advance** button on the phase rail several times in quick succession to bring the phase status up to current reality. Each click fires SMS + email + a `project_portal_updates` row synchronously ([src/server/actions/project-phases.ts:127](src/server/actions/project-phases.ts:127)). The customer's phone lit up with a barrage of texts — felt glitchy, not professional.

2. **Phase model is too heavy and too domain-coded for non-permitted jobs.** The seed in [supabase/migrations/0132_phase_sets_per_vertical.sql](supabase/migrations/0132_phase_sets_per_vertical.sql) ships an 11-step renovation roadmap (Demo → Framing → Drywall → Cabinets → …) that fits a permitted full reno but not a small bathroom refresh, a barn build, a deck, or anything we haven't anticipated. The existing per-vertical sets bake in domain assumptions we're not equipped to maintain as the platform broadens.

## Goal

Phases on a project are **the contractor's**, not ours. Every project starts with a minimal, neutral set; the contractor shapes it to fit *this* job in-place on the Portal tab; advancing a phase notifies the homeowner once, calmly, with an undo grace period.

## Non-goals

- Tenant-level phase template library. Worth doing later (option **D** from the brainstorm) once we see real usage patterns. Not in this plan.
- Auto-deriving phase from task / calendar / photo signals (option **E**). Eventually attractive; out of scope here.
- Renaming or re-modelling `project_phases` itself. The table shape is fine — we're changing seeds and adding edit primitives.
- Any redesign of `project_portal_updates`, photo gating, change orders, decisions, or selections. Phase rail only.

## Design decisions

1. **Generic seed for everyone.** All new projects, regardless of `tenants.vertical`, seed with a minimal four-phase set: `Planning → Active → Walkthrough → Done`. We do not delete the per-vertical branching code path — we just reduce every branch to the generic set. The vertical column remains intact for other uses.
2. **No upfront wizard at project creation.** Project create stays a hot, low-friction flow. The minimal seed means the project is *valid* from creation; the contractor edits the phase rail when they're ready (often before enabling the portal, sometimes mid-project).
3. **Editing happens on the Portal tab.** That's the surface where contractors are already thinking about the homeowner view. Add/rename/reorder/delete are inline on the existing phase rail. Re-use [src/components/features/portal/phase-rail.tsx](src/components/features/portal/phase-rail.tsx) with an Edit mode toggle; do not introduce a separate phases page.
4. **Existing projects keep their existing phases.** Backfill is non-destructive. A contractor with a 6-month-old reno project won't suddenly lose their 11-row rail. They can prune it manually if they want.
5. **Notify on phase advance is deferred and replaceable.** When the contractor advances, we don't send immediately. We *schedule* the notify for ~5 min out and show the contractor a toast with a countdown + Undo. If the contractor advances again before the timer fires, the pending notification is replaced (the homeowner gets one message naming the *latest* phase, not a chain). If the contractor hits Undo, no notification fires at all. Same mechanism applies to email; the `project_portal_updates` row is also deferred so the operator-side feed stays in sync with what the homeowner saw.

## Data model changes

### Phases — no schema change

`project_phases` already supports add/rename/reorder/delete via per-row mutations. We just need server actions and UI. The `UNIQUE (project_id, display_order)` constraint means reorder needs a two-step or a deferred-constraint update (see Phase 1, Step 3).

### Deferred notify — one new column, one cron route

Add to `project_phases`:

```sql
ALTER TABLE public.project_phases
  ADD COLUMN notify_scheduled_at TIMESTAMPTZ,
  ADD COLUMN notify_sent_at      TIMESTAMPTZ,
  ADD COLUMN notify_cancelled_at TIMESTAMPTZ;

CREATE INDEX idx_project_phases_notify_pending
  ON public.project_phases (notify_scheduled_at)
  WHERE notify_sent_at IS NULL
    AND notify_cancelled_at IS NULL
    AND notify_scheduled_at IS NOT NULL;
```

Why on the phase row, not a separate queue table:

- A pending notification is 1:1 with the phase that's currently `in_progress`. There's nothing else to model.
- Advance fast = same phase row gets `notify_scheduled_at` updated again? No — advancing means the current phase becomes `complete` and the next one becomes `in_progress`. The right behaviour is: **on advance, cancel the prior in-progress phase's pending notify (if any) and schedule a new one on the new in-progress phase**. The "replace" semantic is "cancel previous, schedule next" — naturally expressed on the phase row.
- Index is partial — only pending rows are scanned by the cron drainer.

### Cron route

`src/app/api/cron/portal-phase-notify/route.ts`, runs every minute (`* * * * *` in `vercel.json`). Picks rows where `notify_scheduled_at <= NOW()` AND `notify_sent_at IS NULL` AND `notify_cancelled_at IS NULL`. Sends SMS + email + writes `project_portal_updates`. Stamps `notify_sent_at`. Idempotent.

## Phase 1 — Generic seed + per-project editing

**Goal:** New projects get a 4-phase generic rail; contractors can edit any project's rail.

### 1.1 Migration: collapse seed function to generic set

New migration `01XX_phases_generic_seed.sql`. Replace `seed_project_phases_on_insert()` so every branch returns the same array:

```sql
CREATE OR REPLACE FUNCTION public.seed_project_phases_on_insert()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.project_phases WHERE project_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.project_phases
    (tenant_id, project_id, name, display_order, status, started_at)
  VALUES
    (NEW.tenant_id, NEW.id, 'Planning',     1, 'in_progress', NOW()),
    (NEW.tenant_id, NEW.id, 'Active',       2, 'upcoming',    NULL),
    (NEW.tenant_id, NEW.id, 'Walkthrough',  3, 'upcoming',    NULL),
    (NEW.tenant_id, NEW.id, 'Done',         4, 'upcoming',    NULL);

  RETURN NEW;
END;
$$;
```

Existing projects are not touched. Only new inserts.

### 1.2 Server actions

New file `src/server/actions/project-phases.ts` (extending the existing one):

- `createPhaseAction(projectId, name, afterPhaseId?)` — append, or insert after a specific phase. Renumbers `display_order` of subsequent rows.
- `renamePhaseAction(phaseId, name)` — pure name update.
- `deletePhaseAction(phaseId)` — refuses if it's the only phase. If deleting the `in_progress` phase, the next `upcoming` phase becomes `in_progress` (and triggers the deferred-notify path from Phase 2). Renumbers subsequent rows.
- `reorderPhasesAction(projectId, orderedIds[])` — single transaction. Use the `DEFERRABLE INITIALLY DEFERRED` pattern on the unique constraint, or do it in two passes (first set `display_order = display_order + 1000` to dodge the conflict, then set final values). Two-pass is simpler and we already do similar elsewhere.

All four are tenant-scoped through RLS — no app-side tenant filter.

### 1.3 UI: Edit mode on phase rail

[src/components/features/portal/phase-rail.tsx](src/components/features/portal/phase-rail.tsx) gets an "Edit phases" toggle visible only on the operator-facing project Portal tab (the public `/portal/[slug]` page never shows edit affordances).

Edit mode capabilities:

- Inline rename (click name → input → blur saves)
- Delete (× button next to each phase, with confirm dialog matching the project's existing pattern — see [PATTERNS.md](PATTERNS.md))
- Drag to reorder (use the existing dnd lib if present; otherwise up/down buttons — check what's used elsewhere first)
- Add phase (button at end → input → enter saves)
- Exit edit mode → rail returns to the Advance/Regress controls

Match existing UI patterns from PATTERNS.md (inline edits, confirm dialogs, server-action result toasts).

### 1.4 Tests

- Unit: each new server action under `tests/server/actions/project-phases.test.ts` (or wherever the existing tests live — match it).
- Integration: a project with 4 default phases, contractor adds two, deletes one, reorders, advances; assert the rail state matches expectation.

### 1.5 Verification

- Create a new project → rail shows 4 generic phases, "Planning" is `in_progress`.
- Edit mode → add "Demo" between Planning and Active → save → reload → still there.
- Delete "Active" while it's `upcoming` → no orphan rows; subsequent `display_order` values are 1..N.
- Existing project from before this migration ships → rail unchanged.

## Phase 2 — Deferred notification with undo

**Goal:** Advance no longer pings the homeowner immediately. Contractor sees a 5-min countdown they can cancel or that gets replaced by a subsequent advance.

### 2.1 Migration: notify columns + index

The `ALTER TABLE` block above. Single migration `01XX_phase_notify_deferred.sql`.

### 2.2 Rewire `advancePhaseAction`

Replace the synchronous `notifyHomeownerOfPhase` call with a scheduling step:

- When a phase transitions to `in_progress`:
  - Set its `notify_scheduled_at = NOW() + interval '5 minutes'`.
  - Clear any other phase on the project where `notify_sent_at IS NULL AND notify_cancelled_at IS NULL` by stamping `notify_cancelled_at = NOW()`. This is the "replace" semantic.
- The action returns `{ ok: true, notifyScheduledAt }` so the UI can render the countdown.

Move the `project_portal_updates` insert (operator-side feed row) into the cron drainer too — it should fire when the homeowner is actually notified, not at advance-click. This keeps the operator's view aligned with what the homeowner saw.

### 2.3 New action: `cancelPhaseNotifyAction(phaseId)`

Stamps `notify_cancelled_at = NOW()`. Used by the Undo button. RLS guards tenant scope.

### 2.4 Cron drainer

`src/app/api/cron/portal-phase-notify/route.ts`:

```
SELECT ... FROM project_phases
WHERE notify_scheduled_at <= NOW()
  AND notify_sent_at IS NULL
  AND notify_cancelled_at IS NULL
LIMIT 100;
```

For each row: load project + customer (re-using the body of the existing `notifyHomeownerOfPhase`), send SMS + email, insert the `project_portal_updates` milestone row, stamp `notify_sent_at = NOW()`. Errors per row don't fail the batch. Caps at 100/run; will catch up next minute if there's a backlog.

Add to `vercel.json`:

```json
{ "path": "/api/cron/portal-phase-notify", "schedule": "* * * * *" }
```

Auth: standard Vercel cron secret check matching the other cron routes.

### 2.5 UI: countdown toast + Undo

After the contractor clicks Advance:

- Toast appears: **"Notifying [Customer first name] in 5:00 — [Undo]"**
- Countdown ticks visibly.
- Undo button calls `cancelPhaseNotifyAction`; toast collapses to **"Notification cancelled."**
- If the contractor advances again before the timer fires, the toast updates to reflect the new phase: **"Notifying [Name] about *Walkthrough* in 5:00"**. Internally this is "cancel old, schedule new."
- Optional polish: a small "Notify now" link on the toast for the rare case where the contractor is sure and wants to skip the wait. Keep it small — the default behaviour is the right one.

If the contractor closes the browser, the cron still fires; the toast is purely a UI affordance over server state.

### 2.6 Tests

- Unit: advancing twice in 30s leaves exactly one pending notify on the new phase, with the previous one cancelled.
- Unit: cancel action stamps `notify_cancelled_at` and prevents the cron from picking it up.
- Integration: full loop — advance → wait past `notify_scheduled_at` → run cron handler manually → SMS + email + portal_update row all appear once.

### 2.7 Verification

- Live test: advance 3 phases in 10 seconds → wait 6 minutes → customer receives one SMS naming the third phase.
- Live test: advance, then click Undo within 5 min → no SMS arrives.
- Live test: advance, close browser, walk away → SMS arrives ~5 min later.

## Migration / backfill posture

- **Existing projects:** untouched. The seed function change only affects new inserts. Contractors with the old 11-phase reno rail keep it; they can prune via the new edit UI.
- **In-flight phase rows:** notify-deferred columns default to NULL. Old rows behave correctly (cron skips them). No backfill needed.
- **Per-vertical seed function:** retained as a function but every branch returns the generic set. Rationale: keeps the column reference and trigger wiring intact; minimises blast radius. A future plan can drop `tenants.vertical` from the function entirely if we conclude verticals shouldn't drive *anything* about phases.

## Open questions

1. **Notify delay duration.** I've written 5 min as the default. Worth confirming with John — 3 min feels twitchy, 10 min feels like the homeowner thinks no one's in charge. Will default to 5 unless told otherwise.
2. **What happens on regress?** Currently `regressPhaseAction` doesn't notify. Should it cancel a pending notify on the phase being un-started? Yes — same cancel logic. Will include in Phase 2.
3. **`project_portal_updates` row timing.** The current code writes the operator-side feed row at advance-click. I'm moving it to the cron drainer so the feed only shows what the homeowner actually saw. Worth flagging in case anyone relies on the immediate-write behaviour elsewhere — quick grep before shipping.
4. **Edit mode on the public `/portal/[slug]` page.** Confirming: edit affordances appear only on the operator-side Portal tab inside the project detail page, never on the public homeowner-facing page. Plan assumes this.

## Out of scope (future plans)

- Tenant-level phase templates ("Save this rail as a template", "Apply template to new project"). Revisit once we have ~30+ contractors with edited rails — we'll see real clusters.
- Auto-deriving phase from project state (tasks, calendar events, tagged photos). Henry-suggests pattern; v3+.
- Per-phase scheduled date / planned duration on the rail (would tilt this toward a Gantt — explicitly not what phases are).
- Customer-side reactions to phase notifications (reply, ask question). Out of scope; the existing inbound email path handles general inbound.
