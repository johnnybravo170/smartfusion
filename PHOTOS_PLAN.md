# Hey Henry Photo System — Build Plan

**Started:** 2026-04-19
**Source spec:** `HeyHenry Photo System — Research Synthesis + Design Spec (April 2026)` (HenryOS vault, strategy collection)

## Guiding principle

**Henry thinks so you don't have to.** Every user-input moment in the photo
workflow is evaluated against: "can AI make this better / simpler / or go
away entirely while staying accurate?" Henry never hard-blocks — it suggests,
surfaces confidence, and learns from corrections.

## Locked-in judgment calls

- **Auto-tag confidence threshold:** ≥85% silent apply, 60–85% shown with
  tap-to-confirm, <60% leave untagged with "Henry couldn't tell, what is
  this?" Revisit after observing real-world accuracy.
- **Correction learning:** yes — per-tenant preferences captured from
  accepted/rejected AI decisions. Stored in a namespaced `tenant_prefs` table
  so the same mechanism extends to email voice, social captions, etc.
- **Storage:** Supabase Storage for now. R2 migration deferred to Phase 6 —
  orthogonal to every feature, back-migratable with a batch script.
- **Native mobile:** skipped in web phases. Offline queue, 200-job cache,
  device camera beyond browser default — all deferred to the Expo/native
  build (targeted after web Phase 3 lands).

## Phases

### Phase 1 — Data model + schema for intelligence
Everything Henry needs to be smart must exist as a queryable field.

- Expand `photos`: GPS (lat/lng/accuracy), timestamp (taken_at, uploaded_at),
  uploader_user_id, source, device jsonb, width, height, bytes, mime,
  ai_tag + ai_tag_confidence, ai_caption + ai_caption_confidence,
  caption_source ('user'|'ai'|'hybrid'), original_exif jsonb
  (internal-only, stripped from served output), dominant_color
- Extend tag vocabulary: before, after, progress, damage, materials,
  equipment, serial, other
- New tables: `photo_albums` (custom only — system albums are filtered
  views), `photo_album_members`, `photo_pairs`, `photo_share_links`
- New tables: `tenant_prefs` (namespaced JSONB for per-tenant learning
  across the app, not just photos)
- EXIF strip + variant generation deferred to Phase 2 — Phase 1 is
  schema-only; existing capture flow keeps working.

### Phase 2 — Henry layer
Where the magic lives.

- On upload: async worker calls Claude w/ image + job context → ai_tag,
  ai_caption, confidence. Threshold-gated apply per the 85% rule.
- Auto-pair on job Complete: match arrival-state photos to completion-state
  photos via subject + GPS + timestamp. Store in `photo_pairs` with
  created_by='ai' and a confidence score.
- Bad-photo detection: blur/dup/too-dark flags. Silent recapture nudge.
- Correction learning: every override writes to `tenant_prefs.photos`.
  Examples: custom tag vocabulary ("action" for "progress"), confidence
  threshold overrides per tenant, album naming preferences.

### Phase 3 — Closeout loop (first end-to-end feature)
The demo that proves the concept.

- Job status → Complete triggers the closeout builder:
  1. Henry picks best before/after pairs (visual contrast + subject
     coverage heuristic)
  2. Henry writes the narrative (tenant voice profile if set, else
     vertical default)
  3. Assembles a branded report (public URL + PDF)
  4. Fires `job_completed` event into AR → prewritten closeout email sends
     with the report link and primary pair embedded
- One-tap send. Operator approves preview or skips.

### Phase 4 — Workflow integration
Photos become connective tissue.

- Arrival prompt on status → In Progress
- Completion prompt on status → Complete
- Checklist `photo_required` flag + Henry pre-suggests which items need
  photos based on vertical + item text
- Invoice generation auto-attaches best 3–5 completion photos to the PDF
  proof packet
- On-demand dispute/warranty packet: "Hey Henry, build a dispute packet
  for the Henderson job" → GPS-verified bundle in seconds
- Inbox anomaly surfacing: "Job marked complete with no after photos,"
  "14 untagged photos from yesterday"

### Phase 5 — Client-facing surfaces
The CompanyCam parity story.

- Live gallery share link (no-login public URL, auto-updates as photos
  upload). Scoped share links for album / pair set / date range.
- Customer-sent uploads — client can attach photos to the job from the
  portal (flagged as `source='client'`, sorted into "Customer-Sent" album).

### Phase 6 — R2 migration
When volume or egress cost justifies it.

- Cloudflare R2 bucket in ca-central-1
- Sharp pipeline generating thumbnail / medium / original variants on upload
- Native Cloudflare CDN serving
- Back-migrate existing Supabase Storage files via batch script
- Migration is orthogonal to every feature — no UI/UX changes, no schema
  change except `storage_backend` column if we want to run hybrid during
  cutover.

### Deferred (native mobile era)
- Offline capture queue
- 200-job local cache
- Overlay alignment tool
- AI voice walkthrough ("walk the job and talk")
- Map view for multi-location jobs
- 3D scanning

## Integration points (not all Phase 1)

Photos touch every module. Marking which phase each integration lands:

| Integration | Phase |
|---|---|
| Job detail page — existing gallery | P1 (keep working) |
| Arrival/completion prompts | P4 |
| Checklist "photo required" | P4 |
| Quote — attach before-state photos to PDF | P4 |
| Invoice — proof packet auto-attach | P4 |
| Customer portal — live gallery link | P5 |
| AR (autoresponder) — `job_completed` trigger | P3 |
| Social posting — pair feeds into IG/FB queue | post-P3, coordinated with social feature |
| Dispute/warranty packet | P4 |
| Henry chat — "build a report for the Henderson job" | P3 |

## Correction-learning spec

The general-purpose mechanism for Henry getting better per tenant. Not
photo-specific, but photos are the first consumer.

- `tenant_prefs(tenant_id, namespace, data jsonb, updated_at)` keyed by
  `(tenant_id, namespace)`.
- Namespaces: `photos`, `email_voice`, `social`, `invoicing`, ...
- Example `photos` data shape:
  ```json
  {
    "tag_vocabulary": { "progress": "action" },
    "confidence_thresholds": { "silent_apply": 0.90 },
    "preferred_pair_layout": "slider",
    "captions_style": "concise"
  }
  ```
- Every UI correction writes a preference update (debounced / aggregated).
  Henry reads prefs on every inference.

## What's not in Phase 1

Explicitly deferred so we ship fast:

- No UI redesign — existing gallery keeps working
- No EXIF strip pipeline yet (we capture exif to the internal field, but
  the client-facing serving layer comes in P2)
- No AI calls yet
- No share links served publicly yet
- No R2
- No reports, no packets, no closeout loop

Phase 1 = schema only, everything else continues to work unchanged.
