# Sub Quotes — Intake + Multi-bucket Allocation

**Status:** APPROVED 2026-04-23. Phase 1 building now.
**Date:** 2026-04-23
**Author:** Claude + Jonathan

## Problem

GCs receive quotes from subcontractors and suppliers constantly. Painter quotes $18k for upstairs + exterior. Electrician quotes $2,850 for rewire. Lumber yard quotes $6,200 for rough framing materials. Each one maps to one or more cost buckets on a project, and the GC needs to track what they've committed to so cost control can work.

Today in HeyHenry there is no place for a sub quote to live. Bills exist (actuals, post-invoice). Expenses exist (ad-hoc spending). Cost buckets track estimates. But the **committed** layer (what's been promised to subs, before any bill is cut) is missing. Without it, job cost control is incomplete.

JVD's current workaround: nothing. He eyeballs it from memory.

## Goal

Let a GC drop a sub's quote PDF (or email-forward, or photo of a paper quote) into HeyHenry, have it parsed, and assign the dollars across the project's cost buckets with minimum friction. Once accepted, the quote counts as **committed** on each bucket and the cost-control math works.

## Terminology

- **Sub quote**: any incoming quote from a subcontractor, trade, or supplier. The umbrella term used in schema, UI, and docs. Distinct from the existing customer-facing `quotes` table (which we never rename).

## Scope vs. related kanban cards

This plan covers one deliverable: **sub quote intake + bucket allocation**. It lays data foundation for cost control but does not replace the Job Cost Control V1 card — that card adds the variance view, alerts, and lifecycle that use this data.

Overlapping cards this plan supersedes or absorbs:

- `caeec410` Email ingestion for sub-trade quotes → **Phase 3** of this plan. Archive that card once this one is created; the work is tracked here.

Overlapping cards this plan does **not** replace:

- `c24d0da6` Job Cost Control V1 — consumes the `committed` data produced here.
- `5f0179f7` Bill line item extraction — adjacent AI pattern, same extraction tech, different doc type.
- `05fe6570` "Add to Project" universal inbox — we extend it; we don't own it.

## Data model

Two new tables, one join.

```sql
-- One row per sub quote received.
CREATE TABLE public.project_sub_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  vendor_name text NOT NULL,
  vendor_email text,
  vendor_phone text,
  total_cents bigint NOT NULL CHECK (total_cents >= 0),
  scope_description text,          -- raw scope text, for AI matching + display
  notes text,                      -- operator's private notes
  status text NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'accepted', 'rejected', 'expired', 'superseded')),
  superseded_by_id uuid REFERENCES public.project_sub_quotes(id) ON DELETE SET NULL,
  quote_date date,                 -- from the document, if parsed
  valid_until date,                -- from the document, if parsed
  received_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL             -- how it entered HeyHenry
    CHECK (source IN ('manual', 'upload', 'email')),
  attachment_storage_path text,    -- private bucket path to PDF/image
  created_by uuid,                 -- tenant_member id
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sub_quotes_project ON public.project_sub_quotes(project_id, status);
CREATE INDEX idx_sub_quotes_tenant ON public.project_sub_quotes(tenant_id);

-- Many allocations per quote. One row per (quote, bucket) pair.
CREATE TABLE public.project_sub_quote_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_quote_id uuid NOT NULL REFERENCES public.project_sub_quotes(id) ON DELETE CASCADE,
  bucket_id uuid NOT NULL REFERENCES public.project_cost_buckets(id) ON DELETE CASCADE,
  allocated_cents bigint NOT NULL CHECK (allocated_cents >= 0),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sub_quote_id, bucket_id)
);
```

RLS pattern follows every other tenant-scoped table: SELECT + INSERT + UPDATE + DELETE policies gated on `tenant_id = current_tenant_id()`. Learned from the migration 0091 audit: **always add policies when enabling RLS**.

### Invariant

Sum of `allocated_cents` across a sub quote's allocations MUST equal `total_cents`. Enforcement:

- **App layer** in the server action. On save, validate the sum. If not matched, reject with a field-level error on the allocation UI.
- **Not a DB trigger** — brittle, hard to test, and the app-layer check gives us better UX.

Allocations can be zero-count during review (operator hasn't allocated anything yet), but a quote cannot be `status = 'accepted'` until the sum matches.

## UX

### Phase 1 — Manual entry (no AI)

New route: **`/projects/[id]/sub-quotes/new`**. Or, more likely, a dialog accessible from the project's Costs tab.

Form fields:

- Vendor name (required, text with inline suggestions from past vendors on this tenant)
- Vendor email / phone (optional)
- Total ($)
- Scope description (textarea)
- Quote date / valid until (date pickers, optional)
- Notes (optional)
- Attachment upload (optional — same storage pattern as receipts)

Then the **allocation editor**:

```
┌─ Allocate $18,500 across buckets ──────────┐
│ Exterior paint        $ [ 8,000 ]  [×]    │
│ Upstairs interior     $ [10,500 ]  [×]    │
│ [+ Add another split]                     │
│                                           │
│ Allocated: $18,500 / $18,500  ✓ balanced  │
└───────────────────────────────────────────┘
```

- Default: one allocation row with the full total in the first bucket.
- Each row: bucket dropdown + amount input + remove button.
- "Add another split" appends a row.
- Inline bucket creation: a "+ New bucket" option in the dropdown opens a small sub-dialog.
- Live sum at the bottom with green check when balanced, amber when over/under.
- "Save as pending" button: persists with whatever state. Doesn't require balance.
- "Save & accept" button: requires balance, sets status to `accepted`.

Project Costs tab gets a new **"Sub quotes"** section grouped by status, showing each quote with its allocations collapsed under it. Clicking expands or opens the edit dialog.

### Phase 2 — Upload + AI extraction

Operator drops a PDF/image into the project intake zone (`ProjectIntakeZone` — the existing universal inbox). Intake classifier is extended to recognize `sub_quote` as a document type alongside its current categories (bills, expenses, photos, etc.).

On classify-as-sub-quote:

1. AI extracts: vendor name, contact, total, scope text, dates, line items if structured.
2. AI does **scope → bucket matching**: takes the scope text + the list of bucket names on this project, asks the model to suggest allocations. Returns one or more `(bucket_id, allocated_cents, confidence, reason)` tuples.
3. If confidence is high across the board, pre-fill the allocation editor with suggestions.
4. If confidence is mixed, pre-fill the high-confidence ones and leave the rest as open rows.
5. If the scope mentions a concept no bucket covers, AI suggests creating a new bucket and includes that in the suggestion with `new_bucket_name`.

Operator confirms or edits, same UI as Phase 1. The AI suggestion is never silently committed; the dialog always requires a click.

### Phase 3 — Email ingestion (revised 2026-04-23)

**One shared inbox: `henry@heyhenry.io`. Routing keyed off the verified sender email.**

(Earlier draft used per-operator addresses like `ops-{slug}@quotes.heyhenry.io`. That's thrown out — the single-address approach is simpler for operators to remember, simpler to provision, and reinforces the "Henry is a person you email" brand.)

#### Flow

1. Operator forwards a sub's email (with quote attachment) to `henry@heyhenry.io`.
2. Postmark/Resend inbound webhook delivers the parsed email to HeyHenry. SPF + DKIM alignment enforced — unaligned mail is rejected (standard anti-spoofing).
3. Match the from-address against:
   - `auth.users.email` **of a tenant_member with role='owner'** (primary operator email, already verified at signup)
   - `tenant_members.additional_forwarding_emails` (future: verified aliases, e.g. personal iPhone mail)
   - Worker accounts are NOT valid forwarding sources — only the GC owner forwards quotes.
4. Under the one-owner-per-tenant rule, a verified owner email maps to exactly one tenant, so no tenant disambiguation needed. (Platform admins who happen to be owners on multiple test tenants are the exception; they'll get a disambiguation UI if they ever forward.)
5. Pick the project: AI scans subject + body + attachment for customer/project name hints, matches against this tenant's projects. If multiple candidates or low confidence: land the item in a **"Needs assignment"** triage queue on the dashboard.
6. Once routed to a project, pipeline is identical to Phase 2 — same parse prompt, same bucket-allocation confirmation UI.

#### Unknown senders

Email from an address we don't recognize gets a polite bounce:
> "I don't recognize this sender. Forward from your HeyHenry account email, or add this address as a forwarding alias in Settings → Security."

One-time setup friction for operators who want to forward from multiple personal addresses; safe-by-default for the rest.

#### Open questions for Phase 3 build

1. Postmark vs Resend Inbound? (Whichever we're already paying for — likely Resend given the current stack.)
2. Add a "verified forwarding addresses" section to Settings → Security now, or defer until an operator asks for it?
3. Triage-queue UX on the dashboard — dismissible card similar to the awaiting-approval list?

Full spec lands when Phase 2 is shipped and we pick up this phase.

### Phase 4 — Cost Control V1 integration

Scope for card `c24d0da6`. Each bucket's variance view now has three numbers:

- **Estimated**: `project_cost_buckets.estimate_cents`
- **Committed**: SUM of `project_sub_quote_allocations.allocated_cents` for accepted sub quotes in this bucket
- **Actual**: SUM of expenses + bills posted to this bucket

Variance = estimated − committed (risk signal before any bill lands) and estimated − actual (post-spend signal).

## Phased build order

| Phase | What | Ships |
|---|---|---|
| 1 | Tables + RLS + manual-entry form + allocation editor + display on Costs tab | Standalone value: GC can track committed costs the moment this ships. |
| 2 | Upload + AI extract + suggested allocations | Removes data entry friction. Depends on Phase 1 schema. |
| 3 | Email ingestion | Fully hands-off intake. Separate spec when we're ready. |
| 4 | Job Cost Control V1 variance view | Part of `c24d0da6`, not this card. |

Each phase is independently shippable. Jonathan picks when to roll from one to the next.

## Non-goals (V1)

- **Sub quote comparison** (e.g. "Painter A quoted $18k, Painter B quoted $22k, pick one"). Nice feature, later.
- **PO generation from a sub quote.** Separate workflow. A sub quote is the agreement; a PO is the execution document. Don't conflate.
- **Change orders against a sub quote.** When the painter tacks on extra scope, that's a new sub quote or a CO — handle in V2.
- **Retention / holdback tracking.** Important for commercial GC, nice-to-have for residential. Later.
- **Payment scheduling.** Separate concern.

## Decisions locked (2026-04-23)

1. **Costs-tab section** under existing Costs tab. Buckets live there; sub quotes belong beside them.
2. **Low-confidence AI fallback**: editor stays empty. Never pre-fill a first bucket — wrong 95% of the time. Operator must explicitly allocate.
3. **Vendor dedup deferred to Phase 2.** Phase 1: free-text vendor name. Multi-quote-from-same-vendor handling:
   - Each quote = its own row, always.
   - On `accept`, check for existing accepted quote from the same vendor on the same project.
   - If exists AND the new quote's allocations overlap buckets with the existing one → prompt "Replace existing quote ($X) with this one ($Y)?"
   - If exists but allocations are to different buckets (tile guy: kitchen vs bathroom) → prompt "Add as separate quote, or replace existing?" with "separate" pre-selected.
   - On replace: old one flips to `superseded`, `superseded_by_id` points at the new one. Full history stays visible.
4. **Inline bucket creation**: dialog asks for name (required) + section (dropdown: `interior` / `exterior` / `general`; defaults to `general`). `section` is an existing NOT NULL enum on `project_cost_buckets`, so we must pick one — no free-text. `description` defaults to null; `display_order = max(existing) + 10`; `is_visible_in_report = true` (default).
5. **File size/type**: match receipts (10MB, PDF / PNG / JPG / HEIC). Covers 95%+ of real quotes.

## Next step

Once the open questions are answered, I build Phase 1 as a single commit:

- Migration with both tables + RLS policies
- Drizzle schema
- Server actions: `createSubQuoteAction`, `updateSubQuoteAction`, `acceptSubQuoteAction`, `rejectSubQuoteAction`, `setAllocationsAction`
- New component: `SubQuoteForm` + `AllocationEditor`
- New section on project Costs tab

Estimate: 4–6 hours for Phase 1. Phase 2 (AI) is a separate session, similar budget.
