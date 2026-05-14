# Inbound Email V2 — Universal Smart Intake + Activity Log

**Status:** PLAN — pending one more reviewer pass, then execution
**Date:** 2026-05-13
**Author:** Claude + Jonathan
**Supersedes:** scope-limited V1 in `INBOUND_EMAIL_PLAN.md` (kept as the live infra layer; this plan extends rather than replaces it)

## Problem

V1 shipped a working pipeline at `henry@inbound.heyhenry.io` but only classifies two intents: `sub_quote` and `vendor_bill`. Everything else falls into `other` and gets bounced. That's wrong for the brand promise — the inbox is supposed to be "forward Henry anything and he sorts it." Real operator behaviour:

- Forwards a permit PDF from the city → today: bounced as `other`
- Forwards a site photo the foreman texted them → today: bounced as `other`
- Forwards a customer's scope-change email → today: bounced as `other`
- Forwards an inquiry from a referral → today: bounced as `other`
- Forwards a screenshot of a receipt → today: classifier returned invalid `unclassified` (V1 hardening fixed coercion but the intent surface is still narrow)

Also: today's `/inbox/email` is a triage queue, not an activity log. Once an item is `applied` it goes read-only — no edit, no move, no undo. Operators can't easily answer "did that thing come through Henry, and where did it go?"

## Vision

Three things at once:

1. **Universal intent capture.** `henry@inbound.heyhenry.io` accepts anything; Henry classifies + routes to the right destination via operator-confirmed dialogs.
2. **Source-agnostic activity log.** `/inbox/intake` shows ALL Henry intake — email forwards, project drop zone, lead form, voice memos, web share — filterable + searchable. The audit log + triage queue + edit/undo surface, all one place.
3. **Convergence on `intake_drafts`.** The existing universal intake table already does most of this. We extend it; we don't reinvent.

## Architecture

```
Postmark webhook ──────► inbound_emails (envelope: sender, subject, headers)
                            │
                            ▼
                        intake_drafts (one per email; source='email')
                            │
              ┌─────────────┴────────────┐
              ▼                          ▼
   acceptInboundLeadAction    applyIntakeIntentAction(draftId, intent, fields)
   (new customer + project)              │
                          ┌──────────────┼──────────────┐
                          ▼              ▼              ▼
                    project_costs  project_documents  project_messages
                    project_sub_quotes  project_photos  ...

Project drop zone   ──► intake_drafts (source='project_drop')
Lead form           ──► intake_drafts (source='lead_form')
Voice memo          ──► intake_drafts (source='voice')
Web share target    ──► intake_drafts (source='web_share')

ALL flow into:    /inbox/intake   ← single activity log + triage + history + edit
```

## Decisions locked

### Schema — split by concern, single source of truth per concern

The V1 design conflated parser-lifecycle and operator-action-lifecycle into one column. V2 splits them.

- **`intake_drafts.status`** — *parser lifecycle, owned by the AI pipeline.* Existing enum unchanged: `pending | transcribing | extracting | rethinking | ready | failed`.
- **`intake_drafts.disposition`** — **NEW column.** *Operator-action lifecycle, owned by the inbox UX.* Values: `pending_review | applied | dismissed | error`. Default `pending_review`.
- **`intake_drafts.source`** — **NEW column.** *Where did this draft come from?* Values: `email | project_drop | lead_form | voice | web_share`. Default `lead_form` (matches existing rows). Required.
- **`intake_drafts.applied_at`** + **`intake_drafts.applied_by`** — **NEW columns.** Audit trail, populated when disposition transitions to `applied`. Apply to ALL sources, not just email.
- **`inbound_emails.status`** — *collapses to envelope-only.* New enum: `pending | routed_to_intake | bounced`. The V1 statuses (`needs_review`, `applied`, etc.) move to `intake_drafts.disposition`. Migration coerces existing rows: `bounced` stays bounced; everything else maps to `routed_to_intake`. The `applied_*` legacy columns stay for historical readability but aren't written by V2.

### Routes — restructure under `/inbox` (path-based, not tab-based)

Long-term the inbox is the operator's "things demanding attention" hub. Path-based namespace beats `?tab=` for bookmarks, deep links, mobile share targets.

- `/inbox` → thin landing; redirects to `/inbox/intake` (most active surface for ops sessions)
- `/inbox/todos` → existing Todos tab content moved here
- `/inbox/worklog` → existing Worklog tab content moved here
- `/inbox/intake` → **NEW.** Universal Henry intake activity log.
- `/inbox/email` → 308 redirect to `/inbox/intake?source=email` (preserves V1 bookmarks + the project-page banner's "See all" link)

### Intent → destination mapping

| Artifact kind / top-level intent | Operator's primary action | Handler |
|---|---|---|
| `sub_quote_pdf` | Review & confirm sub-quote | existing `SubQuoteForm` (V1, wrapped by new universal action) |
| `receipt` | Confirm vendor bill | existing `StagedBillConfirmDialog` (V1, wrapped) |
| `spec_drawing_pdf` | Attach to project documents | new `StagedDocumentDialog` + new action that writes to `project_documents` |
| `damage_photo` / `reference_photo` | Attach to project gallery | new `StagedPhotoDialog` + new action that writes to `project_photos` |
| `inspiration_photo` / `sketch` | Attach to project intake | reuses `StagedPhotoDialog` routed to intake bucket |
| `customer_message` *(NEW kind)* | Add to `project_messages` | new `StagedMessageDialog` + new action |
| `text_body` *(NEW kind)* | (always present on email drafts; not a destination on its own — informs classification only) | n/a |
| `new_lead` *(top-level draft intent)* | Open lead intake pre-filled | existing `acceptInboundLeadAction` via `/leads/new?fromInbound=<draftId>` redirect |
| `voice_memo` | Defer to V3 | existing transcribe pipeline (no inbox wiring) |
| `other` / unknown | Operator picks from menu | manual destination picker |

### Universal action surface

V1 actions get absorbed into universal versions. Nothing in V2 references the old names.

- **NEW** `applyIntakeIntentAction(draftId, { intent, projectId, fields })` — the universal apply dispatcher. Internally branches per intent and writes to the right destination. Replaces V1's `confirmStagedBillAction` and `linkInboundEmailToSubQuoteAction`.
- **NEW** `editAppliedIntakeAction(draftId, { fields })` — reopens the dialog with current values; on save updates the destination row in place.
- **NEW** `moveAppliedIntakeAction(draftId, { newProjectId })` — updates `project_id` on the destination row + the draft.
- **NEW** `undoIntakeApplyAction(draftId)` — deletes the destination row, sets `disposition='pending_review'`, clears `applied_at/by`. Permissive (single confirm prompt; no lifecycle guards in V2).
- **NEW** `dismissIntakeAction(draftId)` and `restoreDismissedIntakeAction(draftId)`.
- **REUSE** `parseIntakeDraftAction(draftId)` — already universal; the inbox's "Reclassify" button calls this.
- **DELETE** `confirmStagedBillAction`, `linkInboundEmailToSubQuoteAction`, `reclassifyInboundEmailAction`. UI callers update to the new names.

### Operator action menu — state-aware

| Row state (disposition) | Actions |
|---|---|
| `pending_review` | Apply (primary intent) · Pick different intent (dropdown) · Move to project page intake · Dismiss |
| `applied` | View destination · Edit fields · Move to different project · Re-route (undo + immediately re-apply) · Undo |
| `dismissed` | View · Restore (back to pending_review) |
| `error` | View error · Reclassify |
| Email envelope `bounced` | View only (sender wasn't recognised; no draft was created) |

### Filters on `/inbox/intake`

- **Source** — Email · Drop zone · Lead form · Voice · Web share · All
- **Type** — Bill · Sub-quote · Document · Photo · Message · Lead · Other · All (maps to artifact kind primary intent)
- **Disposition** — Pending review · Applied · Dismissed · Error · All
- **Project** — dropdown (existing `?project=<id>` semantics)
- **Search** — single text field, postgres `ilike` against subject + sender + vendor + extracted text + project name. Volume small for V2; FTS upgrade if needed later.
- All filters serialize to URL params for shareable views.

### Per-row source chip

Visual differentiation matters even with filters: ✉️ Email · 📥 Drop zone · 📝 Lead form · 🎤 Voice · 🔗 Web share.

### Subject + leading body as classifier *hint*, not directive

Prompt explicitly tells the model: subject and operator's forwarding note are one signal among others. Weighted appropriately but never override what the attachment shows. Disagreement between subject and attachment lowers confidence and is mentioned in `notes`.

### Auto-apply philosophy unchanged

No threshold of confidence triggers automatic application. Operator confirms every destination via the per-intent dialog. (Same rule from V1.)

### Project banner reuse

Banner query rewrites ONCE to join through `inbound_emails.intake_draft_id` → `intake_drafts.disposition='pending_review'`. After that it's permanent and source-agnostic (could surface non-email staged items too, if useful in V3).

### Bounced emails

Don't get a draft. They're just a record on `inbound_emails` with `status='bounced'`. The `/inbox/intake` view doesn't show them; if we ever need a bounce-audit surface, add a separate `/inbox/email/bounces` later.

## Open questions

None — all major decisions locked.

## File map

### Migration (new, timestamp-prefixed per `AGENTS.md`)
- `supabase/migrations/<TS>_intake_drafts_inbox_v2.sql` — adds 4 columns to intake_drafts, simplifies inbound_emails.status enum, backfills

### Modify
- `src/server/actions/intake.ts` — add `customer_message` + `text_body` to `ARTIFACT_KINDS`; update classify schema; new `createIntakeDraftFromEmailAction`
- `src/lib/ai/intake-prompt.ts` — broaden prompt: forwarded email shape, multi-intent guidance, subject-as-hint, all new artifact kinds
- `src/lib/inbound-email/processor.ts` — replace classifier call with `createIntakeDraftFromEmailAction` + `parseIntakeDraftAction`
- `src/app/api/inbound/postmark/route.ts` — surface draft id in response; status transitions to envelope-only enum
- `src/app/(dashboard)/inbox/page.tsx` — convert to thin landing that redirects to `/inbox/intake`
- `src/components/features/projects/staged-emails-banner.tsx` — query joins through `intake_draft_id` → `disposition='pending_review'`
- Sidebar nav (`src/lib/verticals/load-pack.ts`) — confirm `/inbox` link still resolves; add subnav children if the layout supports it

### Create
- `src/app/(dashboard)/inbox/intake/page.tsx` — universal inbox page
- `src/app/(dashboard)/inbox/todos/page.tsx` — Todos content moved from `/inbox` tab
- `src/app/(dashboard)/inbox/worklog/page.tsx` — Worklog content moved from `/inbox` tab
- `src/app/(dashboard)/inbox/email/page.tsx` — 308 redirect to `/inbox/intake?source=email`
- `src/components/features/inbox/intake-row.tsx` — new universal row card (replaces `inbound-email-card.tsx` long-term; kept as alias for current callers during migration)
- `src/components/features/inbox/intake-filters.tsx` — filter bar + search
- `src/components/features/inbox/intake-actions-menu.tsx` — state-aware dropdown
- `src/components/features/inbox/staged-document-dialog.tsx`
- `src/components/features/inbox/staged-photo-dialog.tsx`
- `src/components/features/inbox/staged-message-dialog.tsx`
- `src/server/actions/inbox-intake.ts` — `applyIntakeIntentAction`, `editAppliedIntakeAction`, `moveAppliedIntakeAction`, `undoIntakeApplyAction`, `dismissIntakeAction`, `restoreDismissedIntakeAction`

### Verify (read only)
- `src/server/actions/intake-augment.ts` — confirm patterns to follow for project_documents/photos/messages writes
- `src/lib/db/queries/intake-drafts.ts` — extend read API for filter bar (source, disposition, search)

### Delete (after migration confirms green)
- V1 actions: `confirmStagedBillAction`, `linkInboundEmailToSubQuoteAction`, `reclassifyInboundEmailAction` from `src/server/actions/inbound-email.ts`
- `src/components/features/inbox/inbound-email-card.tsx` (after `intake-row.tsx` proves out)

## Tasks

Per `writing-plans` skill — each ~2-15 min, commit on done. Phases sequenced; tasks within a phase mostly independent unless noted.

**Sequencing note (the "flip" tasks).** The processor rewrite (A5), webhook touch-up (A6), banner query rewrite (A7), and `/inbox/email` redirect (B3) form a single coordinated cutover at the END of the build. Until they ship, V1 path keeps working — forwarded emails continue landing in the V1 `/inbox/email` UI via `inbound_emails.status='needs_review'`. Once Phase D dialogs + actions exist, we batch A5/A6/A7/B3 in one commit ("the flip") and the unified `/inbox/intake` becomes the single surface. This avoids any window where forwarded emails land in drafts but have no visible UI.

### Phase A — Schema + intake convergence

**A1. Migration**
- Add `intake_drafts.source TEXT NOT NULL DEFAULT 'lead_form' CHECK (source IN ('email','project_drop','lead_form','voice','web_share'))`
- Add `intake_drafts.disposition TEXT NOT NULL DEFAULT 'pending_review' CHECK (disposition IN ('pending_review','applied','dismissed','error'))`
- Add `intake_drafts.applied_at TIMESTAMPTZ`
- Add `intake_drafts.applied_by UUID REFERENCES auth.users(id) ON DELETE SET NULL`
- Add `inbound_emails.intake_draft_id UUID REFERENCES intake_drafts(id) ON DELETE SET NULL` + index
- Drop+recreate `inbound_emails.status` check constraint to envelope-only enum
- Backfill existing `inbound_emails`: `'auto_applied' | 'applied' | 'needs_review' | 'rejected' | 'error' | 'pending' | 'processing'` → `'routed_to_intake'`; `'bounced'` stays. **Legacy rows will have `intake_draft_id = NULL`** — that's fine because they were already actioned in the V1 system and don't need to surface in the new inbox. The banner query in A7 uses an INNER join through `intake_draft_id` so these zombie rows stay invisible.
- Use `supabase migration new` for the timestamp filename per `AGENTS.md`
- Apply, verify (`SELECT pg_get_constraintdef(...)` for the new check constraints), commit

**A2a. Add new ARTIFACT_KINDS**
- `intake.ts:111`: add `customer_message` and `text_body` to the const tuple
- Verify the spread into `ARTIFACT_CLASSIFY_SCHEMA` (intake.ts:210) auto-includes them
- Commit

**A2b. Wire kind → icon for new kinds**
- Update kind→icon map in the existing intake review chip rendering (find via grep of the existing kinds)
- Commit

**A3. Broaden classifier prompt**
- Edit `intake-prompt.ts` to cover: forwarded email shape, multi-artifact emails, subject-as-hint with disagreement guidance, new kinds (customer_message, text_body), explicit guidance that screenshots of receipts → `receipt`, drawings/permits → `spec_drawing_pdf`
- Commit

**A4. `createIntakeDraftFromEmailAction` helper**
- New helper in `intake.ts`
- Takes inbound_emails row + Postmark payload
- Uploads attachments to intake bucket (use existing helpers from intake-augment.ts)
- Creates intake_drafts row with `source='email'`, `text_body` artifact (email body) + per-attachment artifacts
- Returns draft id
- Commit

**A5. Processor rewrite**
- Replace inline classifier call with `createIntakeDraftFromEmailAction` + `parseIntakeDraftAction(draftId)`
- Set `inbound_emails.intake_draft_id` and `inbound_emails.status='routed_to_intake'`
- Commit

**A6. Webhook touch-up**
- Surface draft id in response JSON for downstream test/log visibility
- Commit

**A7. Project banner query rewrite**
- Update `staged-emails-banner.tsx` to join through `inbound_emails.intake_draft_id` → `intake_drafts.disposition='pending_review'`
- Verify it still renders correctly with current data
- Commit

### Phase B — Routes restructure

**B1. Move existing inbox content to subroutes**
- `src/app/(dashboard)/inbox/todos/page.tsx` — extract from current `/inbox` page (todos tab content)
- `src/app/(dashboard)/inbox/worklog/page.tsx` — extract from current `/inbox` page (worklog tab content)
- Both files preserve all existing imports/queries — pure content move
- Commit

**B2. `/inbox` becomes thin landing**
- Replace current `/inbox/page.tsx` with a redirect to `/inbox/intake`
- Pre-launch: hard 308 redirect. (No analytics depends on `/inbox` page views right now.)
- Commit

**B3. `/inbox/email` redirect**
- Replace current page contents with 308 redirect to `/inbox/intake?source=email`
- Preserves bookmarks + project-page banner deep link
- Commit

**B4. Sidebar nav update**
- `src/lib/verticals/load-pack.ts`: change Inbox link from `/inbox` to `/inbox/intake` directly. Avoids a 308 hop on every sidebar click.
- If the sidebar supports nested children: add Todos / Worklog / Intake as children. Otherwise leave flat.
- Commit

### Phase C — Universal intake page

**C1. `/inbox/intake/page.tsx` shell**
- Server-render the row list from `intake_drafts` (left join `inbound_emails` for email-specific display)
- Empty state copy: "Henry's inbox — anything Jonathan or Jason forwards, drops, or speaks goes here first."
- No filters yet
- Commit

**C2. Filter bar component**
- `intake-filters.tsx`: source / type / disposition / project / search inputs
- URL serialization
- Commit

**C3. Wire filters into the page query**
- Read URL params on the server, build the supabase query
- Commit

**C4. Search query builder**
- `ilike` predicate against subject + sender + vendor + extracted text + project name
- Commit

**C5. Intake row component**
- `intake-row.tsx`: source chip + intent badge + disposition badge + sender/subject/project preview + thumbnail (signed URL from intake_drafts.artifacts)
- Commit

**C6. State-aware actions menu**
- `intake-actions-menu.tsx`: render actions based on disposition
- Commit

### Phase D — Server actions + per-intent dialogs

Each task = one action OR one dialog. Commit per task.

**D1.** `applyIntakeIntentAction(draftId, { intent, projectId, fields })` — branch per intent, write to destination.

**D2.** `editAppliedIntakeAction(draftId, { fields })`.

**D3.** `moveAppliedIntakeAction(draftId, { newProjectId })`.

**D4.** `undoIntakeApplyAction(draftId)`.

**D5.** `dismissIntakeAction(draftId)` + `restoreDismissedIntakeAction(draftId)` (single file, both actions).

**D6.** `StagedDocumentDialog`.

**D7.** `StagedPhotoDialog`.

**D8.** `StagedMessageDialog`.

**D9.** `new_lead` redirect — server-side `/leads/new?fromInbound=<draftId>` reads draft + pre-fills the lead form.

**D10.** `other` operator-picker — opens the dropdown by default.

**D11.** Wire `intake-row.tsx` to all dialogs + actions per disposition state. Includes the explicit V1 callsite swaps:
  - `src/components/features/inbox/staged-bill-confirm-dialog.tsx:36` — change `confirmStagedBillAction` import → `applyIntakeIntentAction({ intent: 'vendor_bill', ... })`
  - `src/components/features/inbox/inbound-email-card.tsx` (until E2 deletes it, the SubQuoteForm callsite that uses `linkInboundEmailToSubQuoteAction`) → uses `applyIntakeIntentAction({ intent: 'sub_quote', ... })`
  - Without these swaps, E1's delete of V1 actions will break the build. So D11 must land BEFORE E1.

### Phase E — V1 cleanup

**E1.** Delete V1 actions (`confirmStagedBillAction`, `linkInboundEmailToSubQuoteAction`, `reclassifyInboundEmailAction`) from `src/server/actions/inbound-email.ts`. Verify no remaining callers.

**E2.** Delete `src/components/features/inbox/inbound-email-card.tsx`. Update any stragglers to import `intake-row.tsx`.

### Phase F — Tests + verification

**F1. Manual smoke test — 9 forward shapes**

| # | Forward shape | Expected intent | Expected primary action |
|---|---|---|---|
| 1 | Screenshot of Home Depot receipt | `receipt` | Bill dialog |
| 2 | PDF vendor invoice | `receipt` | Bill dialog |
| 3 | PDF sub-quote from a painter | `sub_quote_pdf` | SubQuoteForm |
| 4 | PDF permit from city | `spec_drawing_pdf` | Document dialog |
| 5 | Site photo from foreman | `damage_photo` or `reference_photo` | Photo dialog |
| 6 | Customer scope-change email ("can we add a fireplace?") | `customer_message` | Message dialog |
| 7 | Inquiry from a stranger ("can you quote my kitchen reno?") | `new_lead` | Lead redirect |
| 8 | Truly random / spam | `other` | Operator picker |
| 9 | Subject says "receipt for Glenwood" + attachment is a permit | `spec_drawing_pdf` (low confidence) + note about subject mismatch | Document dialog with warning |

**F2. Edit / move / undo round-trips** — apply 3 forwards, then edit one field, move one to a different project, undo one. Confirm destination rows correctly updated/deleted.

**F3. Filter + search** — combine filters (source=Email + disposition=pending_review + project=Glenwood + search=permit). Confirm rows match. Confirm URL params reflect state.

**F4. Source-agnostic test** — drop a photo on a project drop zone, confirm it appears in `/inbox/intake?source=project_drop`.

**F5. Worklog entry + close kanban card** — capture each test forward + Henry's classification + operator's actual destination as a labelled set for future prompt tuning.

## Out of scope (V2)

- Splitting a multi-intent email — rare, deferred to V3 with worklog when first observed
- Per-tenant intent customization — every tenant gets the same intent list
- Auto-apply on explicit instructions — still one-click confirm always
- OCR re-runs / classifier re-runs beyond the existing reclassify button
- Voice memo *email forwards* (rare from email; voice from the app stays unchanged)
- Forwarding aliases — owner email only
- Undo lifecycle guards — V3 when accounting comes in (paid bills, signed sub-quotes etc.)
- Top-level mobile nav for `/inbox/intake` — stays in sidebar
- Bounce-audit surface — bounced rows accessible by direct DB query for now; add `/inbox/email/bounces` later if useful

## Risks

- **Classifier confusion on rich forwarded threads.** Mitigated by V1 retry logic + new prompt guidance.
- **`intake_drafts` table growth.** Filter the inbox view server-side to exclude noise.
- **Operator confusion between universal inbox and project drop zone.** Same data, different lens — project drop zone is still per-project capture, `/inbox/intake` is the audit log.
- **Undo destroying real downstream data.** Permissive V2 is risky once accounting/payments come in — V3 lifecycle guards close this. Document the risk in operator-facing copy.
- **Existing `/inbox` users** see one redirect. Acceptable pre-launch.

## Effort estimate

- Phase A: ~half day (schema + classifier)
- Phase B: ~2 hours (route restructure)
- Phase C: ~half day (universal page + filters)
- Phase D: ~1 day (5 actions + 3 dialogs + wiring)
- Phase E: ~1 hour (cleanup)
- Phase F: ~half day (real smoke testing)

Total: **~3 days dedicated session.** Size **13**.
