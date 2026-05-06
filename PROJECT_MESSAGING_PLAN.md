# Project Messaging — Unified Customer Conversation Plane

**Status:** DRAFT 2026-05-06. Awaiting approval.
**Author:** Claude + Jonathan
**Related:** [INBOUND_EMAIL_PLAN.md](INBOUND_EMAIL_PLAN.md) (operator-side ingestion of bills/sub-quotes), [PORTAL_PHASES_PLAN.md](PORTAL_PHASES_PLAN.md) (deferred-notify pattern we'll reuse), [CASL.md](CASL.md) (consent gating).

## Problem

Today, conversations between an operator and a customer are **scattered across surfaces that don't talk to each other**:

1. **Estimate feedback comments** live in `project_estimate_comments`. The operator sees a banner; the customer can't reply once they hit submit.
2. **Notification emails** (estimate viewed/approved/feedback) use the operator's real email as `reply-to`. When the customer hits reply, the message lands in Jonathan's Gmail and **is invisible to HeyHenry** — no audit trail, no banner, no shared context across the team.
3. **No portal comments** exist. The customer can leave feedback once on the estimate but cannot otherwise message the contractor inside the portal.
4. **SMS is one-way today.** The launch checklist calls for two-way SMS threading, but there's no canonical place for those messages to land.
5. **Inbound email infra exists** (Postmark webhook at `/api/inbound/postmark`) but is currently scoped to vendor-bill / sub-quote ingestion only (per `INBOUND_EMAIL_PLAN.md`).

If we build portal comments as their own table now, we'll be migrating it later when we add inbound email and SMS. We should converge first.

## Goal

Build a **single project-scoped conversation log** (`project_messages`) that all three feeders write into:

- Portal (operator and customer both type into the portal UI)
- Email (operator outbound goes via Resend with a per-project reply-to; customer reply lands via Postmark webhook)
- SMS (operator outbound via Twilio; customer reply via Twilio webhook)

Operator and customer see the same scrollback inside the portal and the project page. Henry can read it. The notification email Jon got yesterday becomes a one-paragraph quote of the customer's actual words plus a deep link.

## Non-goals

- Per-estimate / per-phase / per-line-item threading. **Single project-level thread**, with optional `subject` tag (e.g. `"Estimate"`, `"Schedule"`) and `in_reply_to` for attribution. Per Jonathan's call: a flat scrollback beats fragmented threads at this stage.
- Real-time presence ("operator is typing…"). Polling-on-focus is fine for V1.
- Group chat with multiple customers / subs on the same thread. One project = one customer-side conversation.
- Replacing `project_estimate_comments` in this plan. We **fold** that feed into `project_messages` views as a future phase (Phase 4 below). The legacy table stays for historical data.
- Operator-to-operator internal notes. That's a separate `project_notes` concern; not in scope here.
- AI-drafted replies. Henry can read the thread; suggesting replies is a separate later feature.

## Architecture

### One table, three channels

```sql
CREATE TABLE public.project_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  project_id      UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,

  -- Who said it
  sender_kind     TEXT NOT NULL CHECK (sender_kind IN ('operator', 'customer', 'system', 'henry')),
  sender_user_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL,  -- when operator
  sender_label    TEXT,  -- denormalized "Jonathan" / customer name / "Henry" for display

  -- How it arrived / where it goes
  channel         TEXT NOT NULL CHECK (channel IN ('portal', 'email', 'sms')),
  direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'internal')),

  -- Content
  subject         TEXT,           -- optional tag/topic
  body            TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  attachments     JSONB,          -- [{ url, filename, contentType, sizeBytes }]

  -- Threading + provenance
  in_reply_to     UUID REFERENCES public.project_messages(id) ON DELETE SET NULL,
  external_id     TEXT,           -- Postmark MessageID / Twilio SID for dedupe
  inbound_email_id UUID REFERENCES public.inbound_emails(id) ON DELETE SET NULL,

  -- Read tracking
  read_by_operator_at TIMESTAMPTZ,
  read_by_customer_at TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pm_project_created ON public.project_messages(project_id, created_at DESC);
CREATE INDEX idx_pm_tenant_unread ON public.project_messages(tenant_id)
  WHERE read_by_operator_at IS NULL AND direction = 'inbound';
CREATE INDEX idx_pm_external_id ON public.project_messages(external_id) WHERE external_id IS NOT NULL;

-- Per-project routing slug for inbound email/SMS. One slug per project,
-- generated lazily on first outbound. Lives on projects, not messages.
ALTER TABLE public.projects
  ADD COLUMN messaging_slug TEXT UNIQUE;  -- e.g. 'a8k4z2' → proj-a8k4z2@inbox.heyhenry.io
```

RLS: `tenant_id = current_tenant_id()` for tenant access; customers read via the existing `estimate_approval_code`-style portal grant pattern (RPC, not direct table access).

### How each channel feeds in

#### Portal (Phase 1 — smallest shippable)

Customer opens the portal (already authed via the per-project signed link). New "Messages" tab on the portal renders the thread + a textarea. Submit calls a server action (`postPortalMessageAction(approvalCode, body)`) that inserts a row with `channel='portal'`, `sender_kind='customer'`, `direction='inbound'`. Operator-side: same action shape from inside the dashboard, `channel='portal'`, `sender_kind='operator'`, `direction='outbound'`.

Outbound notifications (operator → customer) reuse the **deferred-notify pattern** from `PORTAL_PHASES_PLAN.md`: schedule notification ~30 sec out, drain via cron, replace if operator types again, undo grace.

Inbound notifications (customer → operator): fire immediately, respect `tenant_members.notify_prefs` like the feedback path does today.

#### Email (Phase 2)

**Single inbox address.** All inbound goes through `henry@heyhenry.io` — same address used for the operator's bill / sub-quote forwards. No per-project slugs, no `inbox.heyhenry.io` subdomain, no DNS gymnastics. The `projects.messaging_slug` column added in 0195 stays unused (forward-compat for some hypothetical future need).

**Outbound:** every operator email that wants a reply sets `reply-to: henry@heyhenry.io` instead of the operator's personal email. Notification emails (estimate viewed/approved/feedback, the new portal-message customer notification) all switch. Resend's `replyTo` field handles the From/Reply-To split — the customer still sees the operator's name + the heyhenry sender, but Reply autofills `henry@heyhenry.io`.

**Inbound routing — sender-based, not address-based.** The existing `/api/inbound/postmark` webhook gets a second classifier branch keyed off the **From** address:

| Sender identity | Routes to |
|---|---|
| `auth.users.email` of an owner/admin tenant_member | Existing bill / sub-quote ingestion (per `INBOUND_EMAIL_PLAN.md`) |
| Active customer email on at least one project | New project-message handler → `project_messages` with `channel='email'`, `sender_kind='customer'`, `direction='inbound'` |
| Neither | Polite bounce |

Tenant-member match wins if a sender qualifies as both (rare edge case — a contractor who is also a customer on a different tenant gets the operator-ingestion path).

**Project resolution** (the multi-tenant safety bit):

1. **Primary — `In-Reply-To` header.** Every outbound message's `Message-ID` is stored on its `project_messages.external_id`. The customer's reply carries `In-Reply-To: <that-id>`. Walk back to the row → exact tenant + project + thread, **regardless of how many tenants share that customer email.** This is the source of truth.
2. **Secondary — body footer token.** Every outbound includes a small footer like `[Ref: P-abc123]` (where `abc123` is a 6-char token tied to the project). Most clients quote the body on reply, so the token survives header mangling. Parse it on inbound as a redundant identifier.
3. **Tertiary — recency-within-tenant.** If both primary and secondary fail AND the sender's email matches **exactly one** tenant's customers with recent outbound, use that project. Recency window: outbound within last 30 days.
4. **Bounce** — if all three fail (mangled headers, missing footer, ambiguous tenant match), bounce with: "We couldn't match this reply to a project. Please reply with the original quoted thread, or message your contractor directly."

Privacy guarantee: we **never** surface a customer reply to the wrong tenant. When in doubt, bounce.

**Threading within a tenant:** `in_reply_to` on `project_messages` chains via `In-Reply-To` header → `external_id` of prior outbound row, regardless of which side wrote it.

**Loop guard:** drop inbound where `Auto-Submitted` header is set OR `Precedence: bulk|auto_reply` is present. Customer's autoresponder doesn't become a thread message.

#### SMS (Phase 3)

Outbound: existing `sendSms` becomes `sendProjectSms` when sent in a project context — writes a `project_messages` row at the same time. Twilio number pool is per-tenant (existing pattern).

Inbound: Twilio webhook (likely already exists for STOP handling). Match the inbound number against recent outbound to determine project. Insert as `channel='sms'`, `sender_kind='customer'`, `direction='inbound'`. CASL gating per `CASL.md` — already enforced on outbound, but inbound is implicit consent.

### How the feedback notification email evolves

Today (Phase 1 shipped): the email includes the feedback bodies inline. Phase 2 extension: the email's `reply-to` becomes `henry@heyhenry.io`, so the **customer's** reply (when they hit Reply on this notification — wait, no: this email goes TO the operator, not the customer; the operator's reply doesn't matter here, since they're already inside HeyHenry).

The relevant evolution is on the customer-facing emails — estimate approval, viewed/accepted notifications, and the new portal-message customer notification from Phase 1. Those today have the customer's reply going to the operator's personal email. Phase 2 routes them to `henry@heyhenry.io`, where they land in the project thread.

**Mirror logic:** when an `email`-channel inbound message lands for a project (i.e. the customer has emailed at least once), schedule an outbound email to the customer for any subsequent operator reply on that project, regardless of whether the operator typed it in the portal or replied via email. Same way Slack mirrors a message to email if the recipient prefers.

## Phase plan

Each phase is independently shippable. Phase 1 is the meaningful first cut.

### Phase 1 — Portal comments only (SHIPPED 2026-05-06)

The smallest shippable unit. No inbound email/SMS yet; just a portal-only thread.

- [ ] Migration `01XX_project_messages.sql` — table + indexes + RLS (no `messaging_slug` yet, no `inbound_email_id` FK reference required at this stage but include the column for forward-compat)
- [ ] Server actions: `postProjectMessageAction` (operator), `postCustomerPortalMessageAction(approvalCode, body)` (customer, behind the existing portal auth pattern)
- [ ] Portal UI: Messages tab on the customer portal — thread list + textarea, polling-on-focus refresh
- [ ] Operator UI: Messages section on the project page (re-use existing project tab pattern)
- [ ] Notification: customer-posts-message fires the same notify-prefs flow as feedback, with a polished email matching today's feedback template (quoted body + project deep link). Reuse `estimateFeedbackEmailHtml`-style template.
- [ ] Notification (operator-posts-message → customer): deferred-notify scheduler (~30s) + cron drain + Undo, identical mechanism to phase advance per `PORTAL_PHASES_PLAN.md`. Outbound email for V1; SMS in Phase 3.
- [ ] Read tracking: mark `read_by_operator_at` on operator viewing the project Messages section; `read_by_customer_at` on portal page open.
- [ ] Update `PATTERNS.md` — new "project-scoped thread" pattern.

**Verify:**
- Customer posts in portal → operator gets one email after 30s with the message body and a project link.
- Operator types two messages in 20s → customer gets one combined email, not two.
- Operator hits Undo → no email.
- Both sides see the same scrollback when refreshed.

### Phase 2 — Inbound + outbound email convergence (2-3 days)

**No DNS / Postmark dashboard work required.** All inbound stays on `henry@heyhenry.io`, which is already configured per `INBOUND_EMAIL_PLAN.md` A0.

- [ ] **Helpers — project ref token.** Generate per-project 6-char base32 tokens for the body footer (`P-abc123`). Two options: (a) reuse `messaging_slug` column already on `projects` (rename concept, generate lazily on first outbound), or (b) derive deterministically from `project_id` (HMAC-shorten). Option (b) is simpler — no column writes, no collision retry. Going with (b).
- [ ] **Outbound `reply-to` swap.** Every customer-facing email switches `reply-to` from operator-personal to `henry@heyhenry.io`. Touch:
  - `src/server/actions/estimate-approval.ts` — estimate approval email + viewed/accepted/feedback notifications
  - `src/lib/portal/message-notify.ts` — Phase 1's customer-facing portal-message email
  - Audit any other customer-facing send via `grep -rn "sendEmail" src/` and update if customer is the recipient
- [ ] **Outbound footer.** Every customer-facing email body gets a `[Ref: P-xxxxxx]` footer (project ref token). Small text, near the email's own footer. One helper: `appendProjectRefFooter(html, projectId)` — wraps the email HTML.
- [ ] **Outbound `Message-ID` capture.** Resend assigns Message-IDs; pull from the send response and write to a new `project_messages` row (or to `external_id` on the row that triggered the send). For the deferred-notify cron drainer, this means the row exists BEFORE the send so we have a place to stamp it; that already matches Phase 1's design.
- [ ] **Inbound webhook — sender classifier.** Extend `/api/inbound/postmark` route: after parsing the payload, look up sender:
  - Try `resolve_inbound_sender(from)` RPC (existing per INBOUND_EMAIL_PLAN.md) → tenant_member match → existing flow
  - Else lookup `customers` table where lower(email) = lower(from) AND deleted_at IS NULL → list of (tenant_id, customer_id, project_ids)
  - If neither matches: bounce with the existing helper
- [ ] **Project resolver** for customer-classified inbound:
  - Primary: parse `In-Reply-To` and `References` headers; lookup `project_messages.external_id` IN (parsed ids); pick the matching row → project + tenant
  - Secondary: regex the body for `\[Ref: P-([a-z0-9]{6})\]`; verify against derived token for any of the candidate projects
  - Tertiary: among candidate (tenant, project) tuples, find those with outbound to this email in the last 30 days; if exactly one, use it; if zero or multiple, fall through
  - On all-fail: bounce with "couldn't match to a project" message; log as `inbound_emails` with `status='bounced'` for ops visibility
- [ ] **Project-message inbound handler.** Insert into `project_messages` with `channel='email'`, `sender_kind='customer'`, `direction='inbound'`, `external_id=MessageID`, `in_reply_to` resolved from header chain. Fire immediate operator notification (reuse Phase 1's dispatcher).
- [ ] **Loop guard.** In the inbound handler, drop messages with `Auto-Submitted: auto-replied` OR `Precedence: bulk|auto_reply` BEFORE inserting. Log to console for debug.
- [ ] **Mirror outbound.** Modify Phase 1's `sendMessageNotification` helper: if there's at least one `project_messages` row for this project with `channel='email'` and `direction='inbound'`, the email send is unconditional (today it's already unconditional based on customer email existence — no change needed, just verifies). Confirm by reading the helper.
- [ ] **Verify on live with two-tenant scenario.** Create a second test tenant, give it a customer with the same email as a customer on the original tenant. Send a notification from each. Customer replies to one — verify the reply lands on the right project. Reply with mangled header (forward + edit subject) — verify footer fallback works.

**Verify:**
- Customer replies to an estimate-feedback notification email → message appears in portal scrollback within 1 minute.
- Operator types in portal → customer gets an email + sees the message in portal (Phase 1, regression check).
- Customer replies again → `in_reply_to` chains correctly across email/portal hops.
- Multi-tenant scenario: same customer email on two tenants, reply to one → lands only on the right project, doesn't leak to the other tenant.
- Auto-responder: customer's vacation autoresponder fires on receipt → no row appears in either tenant.

### Phase 3 — SMS two-way (SHIPPED 2026-05-06; live activation pending Twilio 10DLC)

Outbound path was already covered by Phase 1's cron drainer (`sendMessageNotification` sends SMS when the customer has a phone). Phase 3 closes the loop on the inbound side.

- [x] **Inbound routing.** Twilio webhook at `/api/twilio/webhook/inbound` extended with a project-message branch after STOP/START handling. Sender phone → `customers` lookup → list of (tenant, project) candidates → resolver picks one or bounces.
- [x] **SMS resolver.** `src/lib/messaging/sms-customer-router.ts` — single tier (recent outbound match within 30 days). Common case (one customer record per phone) is trivial; multi-tenant collision case bounces by NOT inserting (silent) since Twilio webhook can't easily reply with a clarifying SMS in the response without confusing the customer.
- [x] **Reuses** Phase 2's `dispatchCustomerMessageToOperators` for immediate operator notification when an SMS lands.
- [ ] **Quiet hours** on outbound — already enforced via existing CASL/SMS pipeline.
- [ ] **Live activation** — blocked on Twilio 10DLC / short-code per launch-checklist §14. Code lands now; route is live when 10DLC is approved and per-tenant numbers are configured.

**Verify (post-10DLC):**
- Customer texts back the SMS notification → message appears in project Messages thread.
- Operator types in portal → customer gets SMS (Phase 1 path, regression check) AND sees the message in portal.
- Multi-tenant: customer with two contractors who've both texted them recently — bounces gracefully (no row appears in either tenant).

### Phase 4 — Fold legacy estimate feedback into the unified view (0.5 day)

- [ ] Operator-side project Messages section reads from `project_messages` UNION a view of `project_estimate_comments` (mapped to the same shape with `subject='Estimate feedback'`, `sender_kind='customer'`, `channel='portal'`)
- [ ] New estimate feedback continues to write to `project_estimate_comments` for now (the existing UI banner depends on it). Cut over to `project_messages` writes in a follow-up cleanup.

This phase is intentionally a **view-only** merge so we don't migrate data eagerly. Cleanup of the legacy table is a separate session per CLAUDE.md feature-mode rules.

## Open questions

1. ~~**Per-project email slug format.**~~ Resolved 2026-05-06: dropped the slug entirely. Single `henry@heyhenry.io` inbox; route by sender identity + In-Reply-To header + body footer token.
2. **Should operator-typed emails (Gmail "Reply" to a portal-message notification) land in the project?** Today the operator's notification email has reply-to defaulted to whatever Resend sets — usually the operator's own address. So the operator hits Reply, lands in their own inbox, ignored. Phase 2 could ALSO swap the operator-notification reply-to to `henry@heyhenry.io`, but the inbound handler then needs to handle "operator email replying to own notification" as a new case (insert as `direction='outbound'`). Adds inbound sender allowlist edge cases. Defer to Phase 2.5.
3. **Unknown sender to henry@heyhenry.io.** Spam, mistaken forward, customer's spouse's email. Existing inbound plan already bounces unknown senders. Same path here — no change.
4. **How does Henry participate?** Henry is `sender_kind='henry'` when summarizing or auto-responding. Out of scope for V2 but the column shape supports it.
5. **Multi-tenant projects (subs/GCs in the same project).** Out of scope — see Non-goals. Current customer-only model is fine.
6. **Project ref token derivation.** Going with HMAC of project_id truncated to 6 base32 chars (no DB column writes, no collision handling). Token is reversible only with the server-side secret; harmless if leaked (worst case: spammer learns one project token, still bounces unless they match a customer email).

## Risks

- **Email loop.** Outbound to customer triggers customer auto-responder, which lands as inbound, which we treat as a real reply. Mitigation: detect `Auto-Submitted` header and `Precedence: bulk|auto_reply`; drop those.
- **Multi-tenant cross-leak.** Same customer email on two tenants, reply lands on the wrong project. Mitigation: 3-tier resolver (In-Reply-To → footer token → recency), and BOUNCE on ambiguity rather than guess. Privacy guarantee: never surface a reply to the wrong tenant.
- **Notification fatigue.** A chatty thread + immediate notify on every inbound = spam. Mitigation: deferred-notify on inbound *too*, with a slightly longer window (~2 min) so a customer's three-message burst becomes one notification. (Defer to Phase 2.5 if it shows up in practice.)
- **`In-Reply-To` mangling.** Apple Mail mangles headers on forwards; some clients strip them entirely. The body footer token (`[Ref: P-xxxxxx]`) is the redundant fallback. If both fail and recency is ambiguous, bounce gracefully.
- **Footer token leak.** A spammer who learns one project's token still bounces unless they ALSO match a customer email on that project. The token is not a secret; it's a project disambiguator inside an already-authenticated (via sender) flow.

## Sequencing recommendation

1. **Now (already shipping):** Feedback email fix — bodies inline + polished template. (See branch in progress.)
2. **Next session, Phase 1:** Portal comments. ~1-2 days. Highest user-visible value, no DNS / external dependencies.
3. **After Phase 1 lands and we've watched it for a few days:** Phase 2 inbound/outbound email — once we have signal on whether portal alone is enough or whether email convergence is the obvious next ask.
4. **Phase 3 / 4** as warranted.

## Kanban

Add three cards on the HenryOS board:
- "HeyHenry: Portal project messaging — Phase 1 (portal-only)"
- "HeyHenry: Two-way customer email relay — Phase 2 (inbound/outbound convergence)"
- "HeyHenry: Two-way SMS — Phase 3"

Phase 4 (legacy fold-in) can be a checklist item on Phase 1 rather than its own card.
