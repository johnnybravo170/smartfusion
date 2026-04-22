# Inbound Lead Ingestion — V1 Spec

**Goal:** Turn a messy inbound text thread (screenshot + photos) into a reviewable draft estimate in 5 min of operator time.

**North star example:** JVD receives a text from Lori with scope change (floors + fireplace only), opt-outs ("baseboards OK as-is"), design intent ("chunky brick"), hand-drawn measurement photos, fireplace reference photos, and competitive pressure ("other quotes"). Currently 30-60min of manual work. Target: 5min review of Henry's draft.

---

## Scope (V1 only)

In:
- Manual `/leads/new` form with paste-message field + drag-drop attachments
- Claude/Gemini Vision parses screenshots and reference photos
- Henry drafts: customer record, project shell, estimate with bucket-by-bucket cost lines, reply message
- Operator reviews, edits, accepts → lead becomes a real project
- Competitive urgency flag surfaces on the lead

Out (future phases):
- iOS Share Sheet intent (Phase 2)
- Twilio SMS forwarding number (Phase 3)
- Inspiration board auto-generation (V2)
- Auto-send reply (V2 — stays draft-only in V1, operator always reviews)

---

## User flow

1. JVD on phone receives text thread from Lori.
2. Takes screenshot(s) of the thread. Multi-selects any attached photos via iOS Photos → Share Sheet → Save to a "HeyHenry Intake" album (or just Photos roll).
3. Opens HeyHenry → tap **+ New Project** button in header, picks **"From text thread"** tab.
4. Drag-drops all images (screenshots + photos) into a single drop zone. Optionally pastes plain-text message if screenshots aren't available.
5. Enters customer name (required) — optional phone/email autofills later if extractable.
6. Taps **Parse**.
7. Henry shows a diff-style preview:
   - Drafted customer record
   - Drafted project (name, description, address if extractable)
   - Drafted estimate with buckets and cost lines
   - Drafted reply message in tenant voice
   - Detected signals (competitive, upsell opt-outs, design intent)
8. Operator edits anything inline, removes what's wrong, clicks **Create project**.
9. Lead becomes a real project, reply is copied to clipboard (V1 — no auto-send).

---

## UI

### `/leads/new` page

```
┌─────────────────────────────────────────────────────┐
│ New lead from text thread                           │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Customer name *  [___________________]             │
│                                                     │
│  Drop images here                                   │
│  ┌───────────────────────────────────────────────┐  │
│  │  Screenshots of the thread + reference        │  │
│  │  photos they sent (drag-drop or tap to pick)  │  │
│  │                                               │  │
│  │  [+ Add images]                               │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  Or paste the message text (optional)               │
│  ┌───────────────────────────────────────────────┐  │
│  │                                               │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  [ Parse ]                                          │
└─────────────────────────────────────────────────────┘
```

### Review screen (after parse)

Shows Henry's extractions in an accept/edit layout:

- **Customer** — name, phone, email (fields pre-filled, edit inline)
- **Project** — name, description, address
- **Signals** (chips) — `Competitive (2 other quotes)`, `Upsell: baseboards opted out`, `Design: chunky brick`
- **Estimate draft** — buckets with lines, each line shows source (which photo/message fragment it came from). Delete/edit per line.
- **Reply draft** — editable textarea, tenant voice. "Copy reply" button.
- **Detected photos** — each original photo shown with Henry's proposed bucket assignment and auto-tags.

Bottom: [Cancel] [Create project]

---

## Data model

No new tables for V1 — reuse existing projects / cost_lines / buckets / customers. One new nullable column:

```sql
ALTER TABLE projects ADD COLUMN intake_source text;
-- values: 'manual', 'text-thread', future: 'sms', 'share-sheet'

ALTER TABLE projects ADD COLUMN intake_signals jsonb;
-- { competitive: true, competitor_count: 2, urgency: 'high',
--   upsells: [{ label: 'baseboards', reason: 'opted-out-for-now' }],
--   design_intent: ['chunky brick'] }
```

Intake raw material (screenshots, original images) goes to storage under `projects/<id>/intake/` for audit — not in a new table.

---

## AI pipeline

Single Claude API call with multi-image + structured output. Tool use w/ a strict schema.

**Input:**
- All uploaded images (base64 or storage URLs)
- Optional pasted text
- Customer name
- Tenant context: business name, common bucket templates for this vertical, voice guidelines (pulled from existing tenant settings)

**System prompt** — concise, role + schema + examples:
- Role: intake specialist for a GC/contractor
- Task: distinguish thread screenshots from reference photos; extract the conversation; extract scope, opt-outs, design intent, competitive signals; draft an estimate; draft a reply in the contractor's voice
- Schema: matches `intake_signals` + cost_lines + reply text

**Output schema (strict):**
```ts
{
  customer: { name?, phone?, email?, address? },
  project: { name, description },
  buckets: Array<{
    name: string,
    section: string | null,
    lines: Array<{
      label: string,
      notes: string,
      qty: number,
      unit: string,
      unit_price_cents: number | null, // null = operator must set
      source_image_indexes: number[],  // which uploaded images informed this
    }>,
  }>,
  signals: {
    competitive: boolean,
    competitor_count?: number,
    urgency: 'low' | 'normal' | 'high',
    upsells: Array<{ label, reason }>,
    design_intent: string[],
  },
  reply_draft: string,
  image_roles: Array<{ index: number, role: 'screenshot' | 'reference' | 'measurement' | 'other', tags: string[] }>,
}
```

Operator edits anything before accept. Unset `unit_price_cents` forces the operator to price — Henry doesn't guess pricing in V1.

**Caching:** tenant voice guidelines + bucket templates + schema in the system prompt → cacheable block. Per-call images + customer name are the uncached suffix.

---

## Server action

```ts
// src/server/actions/intake.ts
export async function parseInboundLead(input: {
  customerName: string;
  pastedText?: string;
  storagePaths: string[]; // pre-uploaded to intake/ folder
}): Promise<{ ok: true; draft: ParsedIntake } | { ok: false; error: string }>

export async function acceptInboundLead(input: {
  draft: ParsedIntake; // edited by operator
}): Promise<{ ok: true; projectId: string } | { ok: false; error: string }>
```

`parseInboundLead` does NOT mutate. Only `acceptInboundLead` writes. This lets operator reject cleanly with no cleanup.

---

## Files to touch

- `src/app/(dashboard)/leads/new/page.tsx` — new route, upload form
- `src/app/(dashboard)/leads/new/review-client.tsx` — client component for review screen
- `src/server/actions/intake.ts` — parse + accept actions
- `src/lib/ai/intake-prompt.ts` — prompt + schema (cacheable)
- `src/lib/db/schema/projects.ts` — add `intake_source`, `intake_signals` columns
- `supabase/migrations/<ts>_project_intake.sql` — the migration
- `src/components/layout/header.tsx` — "+ New Project" dropdown gets a "From text thread" option alongside plain new

---

## Testing

- Manual: run JVD's Lori thread through end-to-end. Screenshot the before (raw thread) and after (accepted project). Measure time.
- Unit: mock Claude response, verify `acceptInboundLead` creates project + buckets + lines + sets `intake_signals`.
- E2E (Playwright): upload fixture images, assert review screen renders drafted content, accept, assert project exists.

---

## Acceptance criteria

1. JVD can process Lori's thread (screenshot + 3 photos) in under 5 min operator time.
2. Henry correctly identifies: floors+fireplace scope, baseboards opt-out, chunky brick design, competitive mention.
3. Draft estimate has a Floors bucket and a Fireplace bucket with correct reference photos attached.
4. Draft reply sounds like JVD (review against jonathan-email-voice skill).
5. Competitive flag visible on project after creation.
6. No mutation until operator clicks **Create project**.
7. All uploaded images preserved in `projects/<id>/intake/` for audit.

---

## Open questions

- Pricing: V1 leaves `unit_price_cents` null for operator to set manually. Future: pull from cost_catalog if line label fuzzy-matches.
- Measurement OCR: hand-drawn sketch in Lori's thread has dimensions. V1 just surfaces the photo tagged `measurement`. V2 could OCR and attach a structured measurement set to the bucket.
- Multi-thread merging: what if JVD gets a follow-up text? V1 = new lead. V2 = "Attach to existing lead" flow.
