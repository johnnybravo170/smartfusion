# CASL compliance

Canada's Anti-Spam Legislation governs every email and SMS HeyHenry sends on
behalf of contractors to their customers. Penalties cap at $10M. **Read this
before adding a new send path.**

The full rules with exemptions and edge cases live in the ops knowledge base
("CASL consent rules for HeyHenry"). This doc is the engineering rulebook.

---

## The contract

Every call to `sendEmail` (`src/lib/email/send.ts`) and `sendSms`
(`src/lib/twilio/client.ts`) **must** declare a `caslCategory`. The wrapper
logs the category to `email_send_log` / `twilio_messages` so the send is
auditable.

```ts
await sendEmail({
  tenantId,
  to,
  subject,
  html,
  caslCategory: 'transactional',
  relatedType: 'invoice',
  relatedId: invoice.id,
  caslEvidence: { kind: 'invoice_send', invoiceId, jobId },
});
```

---

## Categories

| Category | Use when | Examples | Evidence to capture |
|---|---|---|---|
| `transactional` | The message confirms / facilitates / completes a transaction the recipient already agreed to. **Exempt from consent.** | invoice, receipt, appointment confirmation, change order, completion notice, password reset, account email, internal team notifications | id of the underlying transaction (invoice/job/quote/changeOrder) |
| `response_to_request` | Direct reply to an inbound inquiry from the recipient. **Exempt from consent.** | first estimate after a quote request, follow-up the customer asked for | inquiry id + when/how it was received |
| `implied_consent_inquiry` | Promotional content sent within **6 months** of an inquiry. | "saw your form 2 months ago, here's a similar project" | inquiry id + timestamp |
| `implied_consent_ebr` | Promotional content sent within **2 years** of last paid job. | "spring promo for past customers" | last paid invoice/job id + timestamp |
| `express_consent` | Newsletter, drip campaign, anything where prior opt-in is required. | AR engine sends, marketing broadcasts | `consent_event_id` from `consent_events` table |
| `unclassified` | TEMP only. Phase B replaces these. | legacy callsites pre-CASL refactor | none |

---

## CEM categories require AR

`implied_consent_inquiry`, `implied_consent_ebr`, and `express_consent` are
all **Commercial Electronic Messages (CEMs)** under CASL. CEMs require:

- Sender ID (the contractor's business name)
- Physical mailing address
- One-click unsubscribe (RFC 8058 for email, STOP keyword for SMS)
- Unsubscribe honored within **10 business days**

**Always send CEMs through the AR engine** (`src/lib/ar/executor.ts`). It
already handles RFC 8058 headers, suppression-list checks, double opt-in,
and engagement webhooks. If you need to send marketing content, build an AR
sequence — do not call `sendEmail` directly with a CEM category.

---

## The mixed-message trap

A message that combines transactional + promotional content is treated as a
**CEM**, not transactional. Example:

> "Here's your invoice — also check out our spring sale on roof inspections."

That bolted-on promo flips the whole message into CEM territory and you lose
the transactional exemption. **Keep transactional and promotional content in
separate sends.** Never add a marketing line to an invoice/estimate/receipt.

---

## PR checklist for new sends

Before merging a PR that calls `sendEmail` or `sendSms`, confirm:

- [ ] **`caslCategory` is set to a real value** (not `unclassified`)
- [ ] **`caslEvidence`** references a real id in scope (transaction id,
      inquiry id, consent_event_id) — not just a string label
- [ ] **`relatedType` + `relatedId`** are set so the send-log row is queryable
- [ ] **No promo content** has snuck into a transactional template (re-read
      the rendered HTML/body)
- [ ] **CEM sends go through AR**, not `sendEmail` directly
- [ ] **For express_consent**, a `consent_events` row exists and its id is
      in `caslEvidence`

---

## When you change an existing send path

Look at every sibling instance in `PATTERNS.md` §12 (CASL-classified sends)
and decide whether the same change applies. Don't silently update siblings,
don't silently skip them.

---

## Schema quick reference

- `email_send_log` — every `sendEmail` call (Drizzle: `emailSendLog`)
- `twilio_messages` — every `sendSms` call (already existed; CASL columns
  added in 0138)
- `ar_send_log` — AR engine sends (already existed; CASL columns added in
  0138)
- `consent_events` — proof-of-opt-in for express_consent sends
  (Drizzle: `consentEvents`)

DDL source: `supabase/migrations/0138_casl_compliance.sql`.
TS schema: `src/lib/db/schema/casl.ts`.

---

## Voice / call recording

Today HeyHenry has two voice surfaces, both operator-only:

- `src/hooks/use-voice.ts` — operator talks to Henry (the AI chat) via the
  browser Web Speech API. No customer audio is captured.
- `src/server/actions/project-memos.ts` — operator records voice notes
  about a project; transcribed locally for the project record.

Neither captures customer audio. CASL voice-recording rules don't apply
to either path.

When the **missed-call lead capture** feature ships (separate kanban
card), it WILL record customer voicemails via Twilio. That's the point
where a recording disclosure becomes mandatory:

- Greeting played at the start of every recorded voicemail must include
  *"This call is being recorded."* (One-line is enough — covers both
  Canadian one-party and US two-party state requirements.)
- Persist a `consent_events` row with `consent_type='voice_recording'`
  per recording, evidence = `{ twilio_recording_sid }`.

Until then, this section is a placeholder.

---

## When in doubt

If a category is genuinely ambiguous, mark it `unclassified` with a
`// TODO(casl)` comment and ship — but only after checking with a
contractor-domain-aware reviewer. `unclassified` should never reach
production for a long-term send path.
