# Customer Idea Board — Customer-Side Inspiration Scratchpad

**Status:** DRAFT 2026-05-06. Awaiting approval.
**Author:** Claude + Jonathan
**Related:** [PROJECT_MESSAGING_PLAN.md](PROJECT_MESSAGING_PLAN.md) (portal-slug auth + polling + tab-badge pattern we're reusing), [PORTAL_PHASES_PLAN.md](PORTAL_PHASES_PLAN.md) (homeowner-facing portal surface conventions), [PHOTOS_PLAN.md](PHOTOS_PLAN.md) (photos bucket + signed URL conventions), [PATTERNS.md](PATTERNS.md) §1 (upload zones), §9 (tabs), §18 (project conversation thread badge pattern).

## Problem

Today, the customer portal at `/portal/[slug]` is **read-mostly + a few narrow write surfaces**: they can leave estimate feedback (one-shot), approve change orders, answer pending decisions, and (Phase 1 of messaging) send a message in the new Messages tab. Everything else they see — phase rail, photo gallery, **selections** — is operator-curated, with the customer in the role of audience.

That leaves a real gap. Between "I'm thinking about a brushed-nickel kitchen faucet" and "the contractor entered Brizo Litze as a project selection" there is a **multi-week period of customer wandering**: Pinterest boards, screenshotted IG posts, Lowes URLs the spouse texted them, the showroom photo from Saturday. Today that lives in:

1. The customer's phone camera roll → the contractor never sees it.
2. A rambling text thread → buried, no structure, no images survive the SMS compression.
3. Pinterest boards the contractor would have to manually go open → friction, never happens.
4. The Messages tab (once Phase 1 lands) → conversation, not a board. URLs and screenshots stack up and scroll off the top; no way to "show me what we've talked about for the kitchen."

When the operator finally sits down to enter `project_selections`, they're working from memory of a fragmented conversation. The customer often feels their preferences were ignored, when really they were just lost in the scroll.

We need a place for the customer to **dump everything that's inspiring them, with zero friction**, that the contractor can passively browse without being pinged.

## Goal

Build a **single project-scoped customer-driven idea board** (`project_idea_board_items`) on the customer portal:

- Customer uploads images, pastes URLs (Pinterest, Lowes, vendor sites), writes free-text notes.
- Each item is a small card: image (or fetched og:image preview) + optional title + optional notes + source-URL link if applicable.
- Items live as long as the project does — they survive into the post-handoff Home Record archive.
- Operator can see the same items on a read-only **"Customer ideas"** section of the project Selections tab. One action: **Promote to project selection** — opens the existing SelectionFormDialog pre-filled, leaves the original idea-board item alone.
- Operator gets a **passive in-app cue** — unread count badge on the Selections tab pill, mirroring how Messages tab badges work today. Clears on open. **No email, no SMS, no push** when the customer adds items: the customer should feel zero hesitation about dumping 30 things at 11pm.

## Non-goals

- **Comments / threading on individual items.** If the customer wants to discuss a specific image, they use the Messages tab. The board is a scratchpad, not a conversation surface.
- **Multi-customer boards on the same project.** The current customer model is one-customer-per-project; the board inherits that. If/when multi-customer projects land, items get a `created_by_customer_id` already in scope, so the migration is just a UI change.
- **Sharing the board outward.** No "share this board with my designer" link. Anyone the operator wants to bring in goes through the operator surface.
- **Editing items after creation.** V1 supports add and delete only. No "rename this card." (Considered: inline title edit. Rejected — adds keyboard contract complexity and a customer's "fix the title later" desire is rare. Easy to add in V2 if it shows up.)
- **Push notifications when the customer adds an item.** Critical non-goal. The whole point is the customer feels safe dumping. Operator pulls (badge), never gets pushed.
- **Operator-side authoring of board items.** The contractor never adds to the customer's board on their behalf. Their authoring surface is `project_selections` (and they can promote a customer idea into one). Operator-side delete is also out of scope V1 — operators **never** delete a customer's items, even by request, in V1. ("Customer asked me to clean up their board" is a rare ask and we'd rather punt to a follow-up than build the moderation UX in the wrong shape.)
- **Per-item ACL or "share toggle" UI.** Single tenant-scoped access model: any operator on the tenant can see the items via the Selections tab. No sharing logic.
- **AI auto-categorization or auto-tagging of items.** Henry can read the board in the future; not in V1.
- **Replacing or folding `project_selections`.** The board is **complementary**, not a replacement. Selections remain the operator-authored install spec / source-of-truth.

## Architecture

### One table

```sql
CREATE TABLE public.project_idea_board_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  project_id      UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,

  -- Authorship — customer_id is nullable for forward-compat (operator
  -- could in theory add an item later; V1 doesn't expose that). When
  -- multi-customer projects land, this disambiguates.
  customer_id     UUID REFERENCES public.customers(id) ON DELETE SET NULL,

  -- What kind of card this is
  kind            TEXT NOT NULL CHECK (kind IN ('image', 'link', 'note')),

  -- 'image' kind: image_storage_path is required (path in photos bucket).
  -- 'link' kind: source_url required; thumbnail_url optional (og:image).
  -- 'note' kind: notes required; image_storage_path / source_url null.
  image_storage_path TEXT,
  source_url      TEXT,
  thumbnail_url   TEXT,         -- og:image fetched server-side for 'link'
  title           TEXT,         -- og:title or customer-supplied
  notes           TEXT CHECK (notes IS NULL OR length(notes) <= 4000),

  -- Optional per-room tag. Free text (matches project_selections.room
  -- which is also free text — no shared room enum across the app yet).
  -- Customer leaves blank when the item doesn't belong to a specific
  -- room ("front yard landscaping", "general vibe").
  room            TEXT CHECK (room IS NULL OR length(room) <= 80),

  -- Operator-side passive read tracking — drives the Selections tab badge.
  -- Per-item, NOT per-tenant — so a contractor with 2 unread items sees "2".
  read_by_operator_at TIMESTAMPTZ,

  -- Promote-to-selection provenance: when the operator clicks "Promote",
  -- we stamp this with the resulting project_selections.id. Original
  -- idea-board row stays intact. Surfaces a "Promoted" badge on the
  -- operator's view.
  promoted_to_selection_id UUID REFERENCES public.project_selections(id) ON DELETE SET NULL,
  promoted_at     TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Body-shape integrity per kind (cheap CHECK; mirrors how
  -- project_messages enforces channel + direction).
  CHECK (
    (kind = 'image' AND image_storage_path IS NOT NULL)
    OR (kind = 'link' AND source_url IS NOT NULL)
    OR (kind = 'note' AND notes IS NOT NULL AND length(notes) > 0)
  )
);

-- Hot query: customer-side board render + operator-side read surface
CREATE INDEX idx_pibi_project_created
  ON public.project_idea_board_items (project_id, created_at DESC);

-- Operator-side unread count for the Selections tab badge
CREATE INDEX idx_pibi_tenant_unread
  ON public.project_idea_board_items (tenant_id, project_id)
  WHERE read_by_operator_at IS NULL;

ALTER TABLE public.project_idea_board_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY pibi_tenant_select ON public.project_idea_board_items
  FOR SELECT USING (tenant_id = public.current_tenant_id());

CREATE POLICY pibi_tenant_insert ON public.project_idea_board_items
  FOR INSERT WITH CHECK (tenant_id = public.current_tenant_id());

CREATE POLICY pibi_tenant_update ON public.project_idea_board_items
  FOR UPDATE USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

CREATE POLICY pibi_tenant_delete ON public.project_idea_board_items
  FOR DELETE USING (tenant_id = public.current_tenant_id());
```

RLS: standard tenant-scoped guard. Customer-side writes go through the **admin client + portal_slug auth** pattern (mirror of `postCustomerPortalMessageAction` in `src/server/actions/project-messages.ts`). The admin client bypasses RLS; the portal_slug + portal_enabled lookup is the authentication step. Operator-side reads/writes go through the authenticated server client and pass RLS naturally.

Cross-tenant RLS test: register `project_idea_board_items` in `tests/integration/cross-tenant-rls.test.ts` per PATTERNS.md §11.

### Storage convention

Image uploads land in the existing **`photos` bucket** under `${tenantId}/idea-board-${projectId}/${uuid}.${ext}` — same first-segment-is-tenant convention as the rest of the bucket. We deliberately do NOT write a companion `photos` table row: idea-board images are scratchpad inputs, not "project photos" in the gallery sense. They render via signed URLs (1-hour TTL) created server-side at page-render time, identical to how `portal-photo-gallery` and `portal-selections` resolve theirs today.

Why reuse the photos bucket instead of a new one: bucket count is itself a maintenance burden (RLS, cleanup, backups, signed URL plumbing all duplicate per-bucket). A dedicated path prefix gives us isolation without a new bucket.

### How items get added

Three customer-side affordances on the portal Idea Board tab. All three call **one** server action, `addCustomerIdeaBoardItemAction(portalSlug, payload)`, which discriminates by `kind`:

#### 1. Image upload (Phase 1)

Drag-drop / click / mobile camera. Same file-shape contract as `src/components/features/photos/photo-upload.tsx` and `src/components/features/contacts/intake-dropzone.tsx` (PATTERNS.md §1). Client-side resize + EXIF strip identical to existing photo-upload. FormData → server action. Server action:
1. Validates portal_slug + portal_enabled (admin client).
2. Resolves `tenant_id` and `customer_id` from the project row.
3. Uploads to the photos bucket under `${tenantId}/idea-board-${projectId}/${uuid}.${ext}`.
4. Inserts a row with `kind='image'` and `image_storage_path` set.
5. Returns `{ ok: true; id }` per the standard server-action contract.

#### 2. URL paste (Phase 2)

Customer pastes a URL into a small inline composer (or an "Add link" button opens the same composer). Client immediately calls `fetchUrlPreviewAction(url)`:
1. Pinterest URLs (`pinterest.com/pin/...`, `pin.it/...`) → call Pinterest oEmbed at `https://api.pinterest.com/oembed.json?url=...` for stable thumbnail + title.
2. Other URLs → server-side `fetch(url)` with a short timeout (5s) + 1MB cap, parse `<meta property="og:image">` / `<meta property="og:title">` / `<title>`. Drop everything else.
3. Return `{ ok: true; thumbnail_url, title }` or `{ ok: false; error }` (we just save the URL alone if og:image lookup fails — preview is best-effort).

The URL fetcher lives at `src/lib/idea-board/url-preview.ts`. SSRF guards: reject `localhost` / `127.0.0.0/8` / `10.0.0.0/8` / `172.16.0.0/12` / `192.168.0.0/16` / `169.254.0.0/16` / file:// / non-http schemes / redirects to private IPs. Mirror the guards we already use anywhere we follow user-supplied URLs (audit before writing).

Customer sees the preview render inline. They can edit the title and add notes, then save. Save calls `addCustomerIdeaBoardItemAction` with `kind='link'` and the resolved fields.

#### 3. Free-text note (Phase 1)

Single textarea on the composer. Save creates `kind='note'` with `notes` populated. Used for "thinking dark wood floors here" without an image or URL.

### How items get viewed and acted on

#### Customer-side (portal)

A new tab on the portal nav: **Project / Messages / Ideas** (third tab). The Ideas tab renders:

- A composer at the top: tabs for "Image" / "Link" / "Note" or three buttons (final UI call during build; stay consistent with the §1 upload-zone styling). Composer also exposes an optional **Room** field (free text, suggestions seeded from existing rooms on the project's selections + prior idea-board items + intake-form room list, like a small autocomplete combobox).
- A **Room filter bar** under the composer when there's at least one tagged item — chips for each distinct room + an "All" + "Unsorted" chip. Filter chips are visual sugar; data is still flat in the table.
- A grid of cards below, ordered by `created_at DESC` (filtered if a room chip is active). Each card shows:
  - Room tag (small pill at the corner) when set.
  - Image kind: signed-URL image, optional notes overlay/below, delete (X) button (customer can delete their own items).
  - Link kind: thumbnail (if available) + title + URL hostname + notes; clicking opens the URL in a new tab.
  - Note kind: text block with the note content.
- An empty state per §6 when there are no items.

Customer can delete their own items. No edit. No reorder. (Room can be set on creation; not editable post-hoc in V1 — same simplicity rationale as the title-edit non-goal.)

#### Operator-side (project Selections tab)

The Selections tab gets a new section at the top, **"Customer ideas"**, above the existing room-grouped selection list. Renders:

- Empty state if no items.
- Otherwise a 3-column grid of cards (same shape as the customer side, minus the composer). Items grouped by `room` when set, falling under an "Unsorted" header otherwise — mirrors how the existing selection list groups by room. (Customer-supplied room strings won't always match operator selection rooms exactly; we surface them as-is so the operator can see "Customer is calling this Master Bath but our selections list says Master Bedroom Ensuite" and reconcile during promote.)
- Each card has one action: **Promote to selection** (opens `SelectionFormDialog` with pre-fills:
  - `room`: idea-board item's `room` (if set) — operator can edit during promote.
  - `category`: defaulted to 'paint' (operator picks); the source content is rarely structured enough to auto-pick, and forcing it would frustrate the operator more than the unfilled default.
  - `name`: idea-board item's `title` (if any).
  - `notes`: idea-board item's `notes` (if any) + a footer line like `\n\nFrom customer idea board: ${source_url}` if it was a link.
  - `photo_refs`: empty in V1 — idea-board images don't live in the `photos` table, and selection `photo_refs` references that table. Future Phase 3 work could mirror an idea-board image into a real photo row at promote time. Punt on that; the operator sees the source image inline on the Promote dialog header so they have visual reference while filling the form.
- Items already promoted show a **"Promoted"** badge with a hover-link to the resulting selection. The original idea-board item stays in place — the operator never deletes the customer's stuff.

**Marking read.** When the operator opens the Selections tab, fire `markIdeaBoardItemsReadAction(projectId)` which `UPDATE`s `read_by_operator_at = now()` for any unread items on that project. Same shape as `markProjectMessagesReadAction`. Mark-read is debounced via the standard Tab open + 200ms idle (already the convention from the Messages tab).

**Tab badge.** The shell at `src/app/(dashboard)/projects/[id]/page.tsx` already has the unread-messages-count pattern wired into `secondaryTabs`. Add a parallel `unreadIdeaBoardCount` query alongside the messages one (cheap, indexed, non-fatal on failure) and render a badge on the Selections pill the same way. **No external notification fires — ever.** (This is the part where we walk away from the obvious "send the operator an email when the customer adds something" temptation.)

### What survives project completion

The board lives on `projects` and is keyed off `project_id`. When a project transitions to `complete`, we do nothing — the board stays. The post-handoff Home Record package (deferred work, see [PHOTOS_PLAN.md](PHOTOS_PLAN.md) and the `home-record-button` family) will eventually pull the board's items into the archive PDF. Phase 4 below is the placeholder; not built in this PR.

The portal page already remains accessible after completion (the slug is the auth grant). Customer can keep adding to the board after handoff if they want — useful for "phase 2 ideas while the contractor is fresh in mind."

## Phase plan

Each phase is independently shippable. **Phase 1 is the full customer surface + operator read-only.** Phase 2 is the operator promote loop. Phase 3 is the deferred Home Record archive integration.

### Phase 1 — Full customer board (image + note + URL) + operator read-only surface (2.5–3 days)

Bundles all customer-side affordances and the operator passive read into a single PR — the customer experience is incomplete without URL paste (Pinterest is the dominant inspiration source), so we don't split it. Operator promote-to-selection is the natural next phase boundary.

- [ ] Migration `01XX_project_idea_board_items.sql` — table + indexes + RLS + the discriminated CHECK constraint + `room` column. **No** `messaging_slug`-style add-on columns; this table doesn't intersect with email/SMS routing.
- [ ] Cross-tenant RLS test entry in `tests/integration/cross-tenant-rls.test.ts` per PATTERNS.md §11.
- [ ] Storage helper `src/lib/storage/idea-board.ts` — thin wrapper for the `${tenantId}/idea-board-${projectId}/${uuid}.${ext}` path, mirrors `src/lib/storage/photos.ts`.
- [ ] **URL preview helper** `src/lib/idea-board/url-preview.ts` — Pinterest oEmbed branch (`https://api.pinterest.com/oembed.json?url=...`) + general og:image scrape. SSRF guards (private IP block, file://, http-only). Hard timeouts (5s connect, 5s body, 1MB cap). Returns `{ ok: true; thumbnail_url, title } | { ok: false; error }`.
- [ ] Server actions in `src/server/actions/project-idea-board.ts`:
  - `addCustomerIdeaBoardItemAction({ portalSlug, kind, room?, ...payload })` — admin-client + portal_slug auth, dispatches by kind. Image kind accepts FormData with the file; note/link kinds accept JSON.
  - `fetchIdeaBoardUrlPreviewAction(portalSlug, url)` — portal_slug-authed wrapper around the URL-preview helper. Per-slug rate-limit (10/min) to prevent abuse.
  - `deleteCustomerIdeaBoardItemAction({ portalSlug, itemId })` — customer can delete their own items only (verify the item belongs to the resolved project from the slug).
  - `getCustomerIdeaBoardItemsAction(portalSlug)` — customer-side polling fetch (returns list with signed URLs resolved server-side).
  - `getProjectIdeaBoardItemsAction(projectId)` — operator-side fetch (RLS-scoped via authed client).
  - `markIdeaBoardItemsReadAction(projectId)` — operator-side mark-read (UPDATE WHERE read_by_operator_at IS NULL).
- [ ] Customer UI:
  - New tab nav entry on `/portal/[slug]` ("Ideas") alongside existing "Project" / "Messages". Keep §9 tab convention: URL-param driven, `?tab=ideas`.
  - `src/components/features/portal/portal-idea-board.tsx` — composer (Image / Link / Note) + optional Room input + grid of cards.
  - Image affordance reuses `intake-dropzone` shell + the photo-upload client-side resize (extract to a shared helper if not already shared; aggressive 640px max-edge target since these are scratchpad images).
  - Link affordance: paste URL → live preview via `fetchIdeaBoardUrlPreviewAction` → save with title/thumbnail_url populated. Card click opens URL in new tab with `rel="noopener noreferrer"`.
  - Note affordance: textarea → save as `kind='note'`.
  - Room input: free-text combobox seeded with distinct rooms from the project's existing selections + prior idea-board items.
  - Room filter chips above the grid when ≥1 tagged item exists.
  - Polling-on-focus refresh at the same 5s cadence as `PortalMessagesPanel`.
- [ ] Operator UI:
  - New section at the top of `selections-tab-server.tsx`: `<CustomerIdeasSection projectId={...} items={...} />`. Read-only cards grouped by room (Unsorted bucket for null `room`). **No "Promote" button in Phase 1** — punted to Phase 2; cards are pure-display.
  - Update the project shell at `src/app/(dashboard)/projects/[id]/page.tsx` to fetch `unreadIdeaBoardCount` alongside the existing `unreadMessages` count, and render a badge on the Selections pill. The pill's `showBadge` predicate extends to `(s.key === 'selections' && unreadIdeaBoardCount > 0)`.
  - Mark-read fires when the operator opens `?tab=selections` (server-side dispatch on tab-render, same shape as the Messages tab mark-read).
- [ ] Update `PATTERNS.md` — add a new section for "Customer-driven scratchpad" surfaces. It's a distinct shape (write-mostly-from-customer, read-from-operator-with-passive-cue) worth cataloging.
- [ ] **No external notifications.** Confirm by audit — no email/SMS in any of the actions.

**Verify:**
- Customer uploads an image → appears in their grid + operator's "Customer ideas" section + Selections pill shows "1" badge.
- Customer pastes a Pinterest pin URL → thumbnail + title resolve from oEmbed; saves as `kind='link'` card.
- Customer pastes a vendor URL with og:image → thumbnail renders from the scraped meta tag.
- Customer pastes a URL with no og:image → card renders with title only, no thumbnail; row still saves.
- Customer adds a free-text note → appears as a note card.
- Customer tags an image with "Master Bath" → room pill on the card; operator sees it grouped under "Master Bath" on the Selections tab.
- Customer deletes an item → disappears on both sides; storage object is deleted (or queued for delete per the photo-delete convention).
- Operator opens Selections tab → badge clears, item shows as no-longer-unread.
- SSRF guards: `http://localhost:3000/admin` rejected. `http://169.254.169.254/...` rejected.
- Timeout: a 30s artificial sleep returns the URL alone after 5s — preview is best-effort.
- Rate limit: 11 preview fetches in 60s — the 11th is rejected.
- No email or SMS fires when the customer adds an item (verify via `email_send_log` and `twilio_messages`).
- Cross-tenant RLS: customer A adds an item, operator B from another tenant can't see it.

### Phase 2 — Operator promote-to-selection (0.5–1 day)

Closes the loop on the customer→selection translation.

- [ ] `promoteIdeaBoardItemAction(itemId)` — server action that reads the item, opens the SelectionFormDialog with pre-fills (category default, name from title, notes prefixed with the source URL if applicable). On the dialog's submit, calls the existing `createSelectionAction` AND stamps `promoted_to_selection_id` + `promoted_at` on the idea-board item. Original item stays.
- [ ] Operator UI: the "Customer ideas" card gets a "Promote" button. Clicking opens the existing `SelectionFormDialog` with pre-fills (extend the dialog to accept an `initialValues` prop — small, additive).
- [ ] Operator UI: items with `promoted_to_selection_id IS NOT NULL` show a small "Promoted" pill (link points at the resulting selection within the same tab — anchor-scroll into the Selections list).
- [ ] **Verify:**
  - Operator clicks Promote on a customer image idea → SelectionFormDialog opens with `name` populated from the idea title, `notes` populated from the idea notes + source URL footer.
  - Operator submits → new `project_selections` row created; `promoted_to_selection_id` stamped on the idea-board item.
  - Original idea-board item still visible, now showing a "Promoted" pill.
  - Operator never sees a delete affordance on customer items, even when they're promoted.

### Phase 3 — Home Record archive integration (deferred)

Out of scope for the first PR. Defer until after the broader Home Record handoff package design lands. When it does:

- [ ] Idea-board items with `kind='image'` get included in the Home Record PDF as a "Customer inspiration" section, with notes preserved.
- [ ] Items with `kind='link'` render as a clickable link list (PDF readers handle this fine).
- [ ] Items with `kind='note'` render as a quoted block.
- [ ] Customer can keep adding after project completion (no change — the table doesn't gate on lifecycle stage).

## Open questions

1. **Operator-side delete of customer items?** Locked NO for V1. Open question for V1.5 if a pattern of "customer asked me to clean up" emerges. Likely solution if we add it: a "Hide from operator view" affordance on the operator side that doesn't actually delete, just sets a `hidden_from_operator_at` flag. Simpler than a full moderation flow.
2. **Customer-edit affordance.** V1 is add+delete only. If operators report that customer-uploaded card titles are commonly wrong/garbled (og:title is sometimes ugly), we add an inline title-edit in V2. Notes-edit is a lower priority — customers rarely revisit a note they wrote.
3. **Multi-customer.** `customer_id` is nullable today and the customer-side write path stamps it from the project's `customer_id`. When multi-customer projects land, the slug auth will need to disambiguate which customer is writing — but that's a portal-auth-rework concern, not an idea-board concern. The schema is ready.
4. **Image dedup / duplicate-paste detection.** Customers will paste the same Pinterest pin twice. Do we dedupe by `source_url` per project? Lean toward no — easy to add later, and the customer might have a reason ("I keep coming back to this one"). Out of scope V1.
5. **Storage cleanup on project hard-delete.** `ON DELETE CASCADE` on the FK kills the rows; the `photos`-bucket objects need a separate sweep. Existing pattern: project soft-delete via `deleted_at`, hard-delete is rare and operator-driven. Audit existing `deleteProjectAction` to confirm it cleans up storage objects for the photos bucket — if it does, our path-prefix items get swept along; if not, it's a pre-existing gap to flag separately.
7. **Why a separate table from `photos`?** Because the data shape diverges immediately:
   - Photos have `taken_at`, `caption`, `client_visible`, `portal_tags`, `phase_id`, `favorite`, `deleted_at`. The idea-board doesn't need any of those.
   - The idea-board has `source_url`, `thumbnail_url`, `kind`, `promoted_to_selection_id`. Photos doesn't need any of those.
   - Mixing them means every photos query has to filter `kind != 'idea_board'` (or equivalent). Worse design than a dedicated table.

## Risks

- **Customer feels watched.** If the operator's "Customer ideas" section looks too eager (e.g. red badge + "1 new!" banner), the customer's psychological safety to dump dies. Mitigation: badge is a small unobtrusive count, never a banner; and we **never** notify externally. Build-time check: read the operator surface carefully and make sure it doesn't read as surveillance.
- **Customer dumps 100 items, operator can't find what's relevant.** Per-room tagging is the primary mitigation — operator sees items grouped by room on the Selections tab, and can mentally bucket. For untagged items, lean into the "ignore until selection time" framing. The promote-to-selection flow is the funnel; the board itself can be visually noisy without harm.
- **og:image scraping abuse.** Customer pastes a URL that points at our own internal services. SSRF-guard the fetcher. Also rate-limit per portal_slug (e.g. 10 preview fetches per minute) to prevent the portal from being used as a free URL-validation oracle.
- **Storage cost growth.** Customers can upload arbitrary numbers of images. Add a per-project soft cap (say 100 items) with a friendly "you've added a lot — let your contractor know" message. Hard-cap at 500 to prevent abuse. Open question: do we resize aggressively (640px max edge) before storage to keep per-image cost low? Lean yes — these are scratchpad images, not gallery photos. Reuse the existing photo-upload resize helper; just call it with a smaller max-edge target.
- **Pinterest API changes.** oEmbed is stable but not contract-guaranteed. Fallback to og:image scrape on Pinterest's HTML if oEmbed fails. Caching the response 24h would reduce dependency, but adds caching infra; defer.
- **Customer pastes their bank URL.** The og:image fetcher renders whatever metadata the source page exposes; some sites embed sensitive content in og:images (rare). Mitigation: nothing automatic — it's the customer's choice what they paste. The image is rendered via signed URL, so no public exposure.
- **Tab-badge collision with Messages-tab badge.** Both render via the same secondary-tab pill machinery. Verify the per-pill badge logic generalizes cleanly — current code special-cases `s.key === 'messages'`. We add `s.key === 'selections'` next to it; refactor to a `badgeCounts: Record<TabKey, number>` map only if we're adding a third badge. Two is fine inline.

## Sequencing recommendation

1. **Now:** Phase 1 — full customer board (image + link + note + per-room tag) + operator read-only + passive badge. ~2.5–3 days.
2. **Next session:** Phase 2 — operator promote-to-selection. ~0.5–1 day. Light touch; relies on extending `SelectionFormDialog` to accept `initialValues`.
3. **Phase 3** as warranted — defer until Home Record handoff design lands.

## Kanban

Add two cards on the HenryOS board:
- "HeyHenry: Customer Idea Board — Phase 1 (full customer surface + operator read-only)"
- "HeyHenry: Customer Idea Board — Phase 2 (operator promote-to-selection)"

Phase 3 stays implicit on the Home Record handoff card when that lands.
