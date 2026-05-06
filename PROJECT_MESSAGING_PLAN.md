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

Outbound: every operator email that wants a reply uses `reply-to: proj-{slug}@inbox.heyhenry.io` instead of the operator's personal address. Notification emails (estimate viewed/approved/feedback today) get the swap. The slug is generated lazily on first send and cached on `projects.messaging_slug`.

Inbound: extend the **existing** `/api/inbound/postmark` webhook (don't create a second one). Routing rule:

| To address pattern | Routes to |
|---|---|
| `henry@heyhenry.io` | Existing operator-side ingestion (bills / sub-quotes) — see `INBOUND_EMAIL_PLAN.md` |
| `proj-{slug}@inbox.heyhenry.io` | New customer-reply ingestion → `project_messages` with `channel='email'`, `sender_kind='customer'`, `direction='inbound'` |

Sender allowlist for the project channel: the project's customer's known email addresses (from `customers` and any prior outbound `to_email`). Unknown senders to a project address: bounce *or* park with a "needs review" status — TBD (open question Q3 below).

Threading on inbound: parse `In-Reply-To` and `References` headers; match against `external_id` of prior outbound rows to set `in_reply_to`.

#### SMS (Phase 3)

Outbound: existing `sendSms` becomes `sendProjectSms` when sent in a project context — writes a `project_messages` row at the same time. Twilio number pool is per-tenant (existing pattern).

Inbound: Twilio webhook (likely already exists for STOP handling). Match the inbound number against recent outbound to determine project. Insert as `channel='sms'`, `sender_kind='customer'`, `direction='inbound'`. CASL gating per `CASL.md` — already enforced on outbound, but inbound is implicit consent.

### How the feedback notification email evolves

Today (just shipped): the email includes the feedback bodies inline. Phase 2 extension: same email's `reply-to` becomes the project address, so the operator can hit Reply in Gmail and the response lands in `project_messages` as `channel='email'`, `direction='outbound'`, the customer sees it in the portal *and* in their inbox (because we mirror back outbound).

Mirror logic: when an `email`-channel inbound message lands for a project, schedule an outbound email to the customer for any subsequent operator reply on that project, regardless of whether the operator typed it in the portal or replied via email. (Same way Slack mirrors a message to email if the recipient prefers.)

## Phase plan

Each phase is independently shippable. Phase 1 is the meaningful first cut.

### Phase 1 — Portal comments only (1-2 days)

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

- [ ] Migration: add `messaging_slug` to `projects`, generation function (`gen_random_bytes(4)` → base32 lowercase, retry on collision)
- [ ] DNS / Postmark: confirm the existing inbound forward catches `proj-*@inbox.heyhenry.io` (subdomain-wildcard, ideally a separate Postmark inbound server from the `henry@` one to keep rules clean — A0 in `INBOUND_EMAIL_PLAN.md` covers the pattern for `heyhenry.io`; `inbox.heyhenry.io` may be a fresh setup)
- [ ] Webhook: add a `to-address` switch at the top of `/api/inbound/postmark` route — `henry@` → existing flow; `proj-{slug}@inbox.heyhenry.io` → new project-message inbound handler
- [ ] New handler: lookup project by slug, validate sender against customer email allowlist, insert `project_messages` row with `external_id = MessageID`, `in_reply_to` resolved from `In-Reply-To` header against existing `external_id`s
- [ ] Outbound email: every operator-side email that wants replies uses `reply-to: proj-{slug}@inbox.heyhenry.io`. Update:
  - Estimate approval email (today: customer's reply goes to operator)
  - Estimate viewed/accepted/feedback notifications (today: operator's reply goes to operator's own inbox — irrelevant since these are notifications, not customer-facing, but the *forward* / *reply-all* could land here)
  - New portal-message notifications from Phase 1
- [ ] Mirror outbound: when operator types a portal message and the customer has previously emailed (i.e. there's at least one inbound email row for the project), include the customer's email in the deferred-notify outbound email send.

**Verify:**
- Customer replies to an estimate-feedback notification email from their own inbox → message appears in portal scrollback within 1 minute.
- Operator types in portal → customer gets an email + sees the message in portal.
- Customer replies again → in_reply_to chains correctly across email/portal hops.

### Phase 3 — SMS two-way (1-2 days, after Twilio short-code or 10DLC is sorted)

- [ ] Audit current `sendSms` callsites — wrap project-context calls in `sendProjectSms` that writes a `project_messages` row with `channel='sms'`
- [ ] Twilio inbound webhook: route by recipient number → tenant; lookup most-recent outbound to that From number → project_id; insert with `channel='sms'`, `direction='inbound'`
- [ ] Quiet hours: enforce on outbound notifications per launch-checklist item §14
- [ ] CASL evidence on every outbound (already standard)

**Verify:**
- Customer texts back the SMS reminder → message appears in project thread.
- Operator types in portal → customer gets SMS (if their channel pref is SMS) and email (if email).

### Phase 4 — Fold legacy estimate feedback into the unified view (0.5 day)

- [ ] Operator-side project Messages section reads from `project_messages` UNION a view of `project_estimate_comments` (mapped to the same shape with `subject='Estimate feedback'`, `sender_kind='customer'`, `channel='portal'`)
- [ ] New estimate feedback continues to write to `project_estimate_comments` for now (the existing UI banner depends on it). Cut over to `project_messages` writes in a follow-up cleanup.

This phase is intentionally a **view-only** merge so we don't migrate data eagerly. Cleanup of the legacy table is a separate session per CLAUDE.md feature-mode rules.

## Open questions

1. **Per-project email slug format.** `proj-a8k4z2@inbox.heyhenry.io` is short but reveals nothing. Alternative: `{customer-first-name}-{slug}@inbox.heyhenry.io` (more human but reveals more in BCC contexts). Default to the short slug.
2. **Should operator-typed emails (Gmail "Reply" to a notification) land in the project?** This means the operator's `reply-to` would need to also point at `proj-{slug}@…`, but the operator should still see the original customer's address as the visible recipient. Achievable via the From/Reply-To split in Resend. Worth doing — it makes Gmail a viable operator-side surface — but adds inbound sender allowlist edge cases (operators sending from their personal email that may or may not match `auth.users.email`).
3. **Unknown sender to a project address.** Spam, mistaken forward, customer's spouse's email. Bounce, or stage with `status='needs_review'` for the operator to allowlist? Default: bounce with a clear message ("only the original recipient can reply to this thread").
4. **How does Henry participate?** Henry is `sender_kind='henry'` when summarizing or auto-responding. Out of scope for V1 but the column shape supports it.
5. **Multi-tenant projects (subs/GCs in the same project).** Out of scope — see Non-goals. Current customer-only model is fine.

## Risks

- **Email loop.** Outbound to customer triggers customer auto-responder, which lands as inbound, which we treat as a real reply. Mitigation: detect `Auto-Submitted` header and `Precedence: bulk/auto_reply`; drop those.
- **Slug enumeration.** Someone could hit `proj-aaa1@inbox.heyhenry.io` and brute-force project slugs. Sender allowlist mitigates content access; bounce-volume could be DoS. Use 8+ chars of base32 (~40 bits) and rate-limit unknown-sender bounces.
- **Notification fatigue.** A chatty thread + immediate notify on every inbound = spam. Mitigation: deferred-notify on inbound *too*, with a slightly longer window (~2 min) so a customer's three-message burst becomes one notification.
- **PostgreSQL `IN_REPLY_TO` resolution edge cases.** Apple Mail mangles `In-Reply-To` on some forwards. Fall back to subject-line "Re:" matching only as a last resort, and accept that some replies won't thread perfectly.

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
