# QuickBooks Online — Integration Plan

**Status:** Draft
**Owner:** Jonathan + Claude
**Target:** V1 launch
**Scope:** One-way push of customers, invoices, and payments from HeyHenry → QBO.
Refunds, item catalog, bidirectional webhook ingest, and QBO Payroll Canada
hours sync are explicit fast-follows, not V1 blockers.

> Read alongside the existing knowledge docs:
> - "HeyHenry — Integration Critical Gotchas & Deadlines" (Apr 2026)
> - "HeyHenry — Payroll Hours Sync Integration Spec v1.0" (Apr 2026)
>
> This plan is the build doc that turns those into code.

---

## 1. Goal

Every contractor with a bookkeeper is on QBO. Without native sync the
bookkeeper kills the deal at renewal. Ship enough that the bookkeeper logs
into QBO, sees clean customers + invoices + payments matching HeyHenry,
and never asks the GC to re-enter anything.

**V1 success looks like:** GC connects QBO in settings → every sent invoice,
recorded payment, and new customer auto-pushes within 60s → bookkeeper sees
matching data in QBO with correct GST, customer, project ref, and payment
method → if a sync fails, the GC sees it on the invoice page and Henry posts
a card to ops.

---

## 2. Testing Strategy

This is the part to think hardest about up front, because QBO has no good
local-dev story.

### 2.1 Three test surfaces

| Surface | What it covers | Cost |
|---|---|---|
| **Intuit Developer Sandbox** | Every dev test, every CI run, every PR preview | Free, unlimited |
| **Jonathan's QBO trial** | One real-world end-to-end pass before launch | Free 30-day trial |
| **First friendly customer** | Real bookkeeper review on real data | Free, but slow loop |

### 2.2 Sandbox setup (primary loop)

Intuit Developer gives every account up to 5 free sandbox companies via
[developer.intuit.com](https://developer.intuit.com). Each is a fully-
functional QBO company with a Canadian variant available (sales tax, GST,
provincial codes). They're identical to production except:
- Lifetime is unlimited (no 30-day expiry like trials)
- Reset-to-clean button — wipe + reseed in one click
- Sandbox API base URL is different (`sandbox-quickbooks.api.intuit.com`)

**Setup:**
1. Create Intuit Developer account (Jonathan, with `riffninjavideos@gmail.com`)
2. Spin up one Canadian sandbox company named "HeyHenry Test Co"
3. Enroll in QBO Apps developer program → get `Client ID` + `Client Secret`
4. Configure OAuth redirect URI: `https://app.heyhenry.io/api/qbo/callback`
   plus `http://localhost:3000/api/qbo/callback` for dev
5. Store sandbox credentials in `.env.local` and Vercel preview env:
   - `QBO_CLIENT_ID`
   - `QBO_CLIENT_SECRET`
   - `QBO_ENVIRONMENT=sandbox` (toggles base URL)
   - `QBO_REDIRECT_URI`

Production gets a separate set of credentials:
   - `QBO_ENVIRONMENT=production`
   - Same client ID/secret variables, different values per Vercel environment

### 2.3 Test matrix (run on every meaningful change)

Each row is one Playwright e2e test that hits the sandbox.

| # | Scenario | Expected QBO state |
|---|---|---|
| 1 | Connect QBO, then disconnect | `tenants.qbo_realm_id` populated then nulled; sync rows deleted |
| 2 | Create customer in HeyHenry | QBO Customer created with name + email + (optional) address |
| 3 | Edit customer name in HeyHenry | QBO Customer updated, same `Id` |
| 4 | Create + send invoice (1 line item, GST) | QBO Invoice with one line, correct `TxnTaxDetail`, customer ref |
| 5 | Create invoice with 5 line items + tax-exempt | QBO Invoice with 5 lines, no tax |
| 6 | Mark invoice paid via Stripe | QBO Payment linked to invoice, `PaymentMethodRef`=Credit Card |
| 7 | Mark invoice paid via cheque (record-payment dialog) | QBO Payment, `PaymentMethodRef`=Check, reference field populated |
| 8 | Mark invoice paid via cash | QBO Payment, `PaymentMethodRef`=Cash |
| 9 | Mark invoice paid via e-transfer | QBO Payment, `PaymentMethodRef`=Other (or custom EFT method) |
| 10 | Void an invoice | QBO Invoice voided (not deleted) |
| 11 | Sync fails (force token revocation mid-test) | `qbo_sync_log.status='failed'`, retry button surfaces, ops card created |
| 12 | Token expires (force expire `expires_at`) | Refresh-token flow runs, sync continues, no user-visible disruption |
| 13 | Reconnect after revoke | Old `realm_id` retained; new tokens overwrite cleanly |

These tests use a single seeded sandbox company that's reset before each
test run via the "reset sandbox data" API endpoint Intuit provides.

### 2.4 Pre-launch verification

Before the QBO card moves to done:
1. Run the full test matrix against the sandbox — all green
2. Jonathan creates a real QBO 30-day trial and runs the same flows
   manually, with a real bookkeeper (Cathy or whoever is testing)
   reviewing the results
3. Document any "looks weird in QBO" feedback as follow-up cards
4. Flip the QBO card to done

### 2.5 Production safety net

- **Sync is async.** Every sync goes through a BullMQ queue. A bad sync
  doesn't block the user-facing action.
- **Idempotency.** Every QBO mutation is keyed on the HeyHenry row id.
  Duplicate syncs are a no-op, not duplicate QBO objects.
- **Sync log table.** `qbo_sync_log` records every push attempt with
  payload, response, and status. Replay button on each failed row.
- **Henry watches.** A nightly cron compares HeyHenry invoice/payment counts
  to QBO counts per tenant. Any drift → ops card with the diff.

---

## 3. OAuth + Auth Model

### 3.1 OAuth 2.0 flow

QBO uses OAuth 2.0 + OpenID Connect. Standard flow:

1. GC clicks "Connect QuickBooks Online" in `Settings → Integrations`
2. Server action builds the auth URL with scopes
   `com.intuit.quickbooks.accounting` (and later
   `com.intuit.quickbooks.payroll` for V2) and redirects
3. User logs into Intuit, picks a QBO company, approves
4. Intuit redirects back to `/api/qbo/callback?code=...&realmId=...&state=...`
5. Callback exchanges `code` for `access_token` + `refresh_token`
6. Store tokens + `realmId` (the QBO company id) on the tenant row
7. Redirect to `/settings/integrations?qbo=connected`

### 3.2 Token storage

Tokens are sensitive. Options ranked:

1. **Supabase Vault** — proper. Rotation, audit, no plaintext at rest.
2. **`pgp_sym_encrypt` with a server-only key** — middle ground, easy to rotate.
3. **Plaintext on `tenants` row, RLS-locked, service-role-only** — ship V1.

For V1 we go with **option 3** to avoid scope creep, with a follow-up card to
move to Vault before customer #20. Tokens never leave the server (no client
read), and the column is service-role-only at the policy level.

### 3.3 Token rotation

QBO access tokens expire in 1 hour, refresh tokens in 100 days (or 180 days
with rolling refresh). Pattern:

```ts
async function getQboClient(tenantId: string) {
  const tokens = await loadTokens(tenantId);
  if (Date.now() > tokens.expires_at - 5 * 60_000) {
    const fresh = await refreshTokens(tokens.refresh_token);
    await saveTokens(tenantId, fresh);
    return makeClient(fresh.access_token, tokens.realm_id);
  }
  return makeClient(tokens.access_token, tokens.realm_id);
}
```

Every refresh persists the new `refresh_token` too — Intuit rotates them on
each refresh and old ones invalidate.

If a refresh fails (e.g. user revoked from inside QBO), set
`qbo_disconnected_at` and surface a banner: "QuickBooks disconnected —
reconnect to resume sync." All sync attempts during this state queue but
don't fire.

---

## 4. Sync Model

### 4.1 Entity map

| HeyHenry | QBO | Sync direction (V1) |
|---|---|---|
| `customers` | `Customer` | HeyHenry → QBO, on create/update |
| `invoices` (status='sent' or 'paid') | `Invoice` | HeyHenry → QBO, on send |
| `invoices` (status='paid') | `Payment` linked to Invoice | HeyHenry → QBO, on record-payment |
| `invoices` (status='void') | Invoice voided in QBO | HeyHenry → QBO, on void |
| `tenants.gst_number` | Sales tax setup | One-time during connection |

**Not in V1:**
- Refunds (RefundReceipt) — fast-follow card
- Items / services catalog — V1 uses one generic line per invoice
- Expenses — `expense-center-v2` epic, post-launch
- Time activities — payroll spec, post-launch
- Bidirectional ingest from QBO webhooks — V1.5

### 4.2 Per-entity push details

#### Customer
- **Trigger:** customer create/update server action
- **QBO call:** `POST /v3/company/{realmId}/customer`
- **Mapping:**
  - `DisplayName` ← `customers.name`
  - `PrimaryEmailAddr.Address` ← `customers.email`
  - `PrimaryPhone.FreeFormNumber` ← `customers.phone` (if present)
  - `BillAddr` ← address fields (if present)
- **Idempotency:** track `customers.qbo_customer_id`. On second call with
  same id, switch to `POST /customer?operation=update` with `SyncToken`.
- **Failure:** queue retries 3× with backoff. If still failing, flag the
  customer row with `qbo_sync_status='failed'` + log to `qbo_sync_log`.

#### Invoice
- **Trigger:** `sendInvoiceAction` (status `draft → sent`)
- **Pre-flight:** customer must have `qbo_customer_id`. If not, sync customer
  first (chain).
- **QBO call:** `POST /v3/company/{realmId}/invoice`
- **Mapping (V1 simple):**
  - `CustomerRef.value` ← `customers.qbo_customer_id`
  - One `SalesItemLineDetail` line with `ItemRef` = generic
    "Construction services" item we create on first connection
  - `Amount` ← `invoice.amount_cents + sum(line_items)`
  - `TxnTaxDetail.TotalTax` ← `invoice.tax_cents`
  - `TxnTaxDetail.TaxLine` ← Canadian GST 5% (configurable per-tenant later)
  - `DocNumber` ← short invoice id `inv-{first8}`
  - `PrivateNote` ← internal note ("Synced from HeyHenry — invoice {full id}")
  - `CustomerMemo` ← `invoice.customer_note` if present
- **Idempotency:** track `invoices.qbo_invoice_id` + `qbo_sync_token`.
- **V1.1 follow-up:** push each line item as its own QBO line. Requires
  Item catalog work — separate card.

#### Payment
- **Trigger:** `markInvoicePaidAction` OR Stripe webhook `checkout.session.completed`
- **Pre-flight:** invoice must have `qbo_invoice_id`. Chain-sync if not.
- **QBO call:** `POST /v3/company/{realmId}/payment`
- **Mapping:**
  - `CustomerRef.value` ← `customers.qbo_customer_id`
  - `Line[0].LinkedTxn` ← `{ TxnId: qbo_invoice_id, TxnType: 'Invoice' }`
  - `Line[0].Amount` ← total invoice amount
  - `TotalAmt` ← total invoice amount
  - `PaymentMethodRef.value` ← QBO payment method id, mapped from
    `invoice.payment_method`:
    - `cash` → "Cash" (built into every QBO company)
    - `cheque` → "Check"
    - `e-transfer` → custom method "EFT" (created on first connection if absent)
    - `stripe` → "Credit Card" (Stripe Connect side) or custom "Stripe"
    - `other` → "Other"
  - `PaymentRefNum` ← `invoice.payment_reference` (cheque #, e-transfer code)
  - `PrivateNote` ← `invoice.payment_notes`
- **Receipt photos:** V1 does NOT push receipt photos as QBO Attachments.
  Add as fast-follow if bookkeepers ask (uses
  `POST /v3/company/{realmId}/upload`).

#### Invoice void
- **Trigger:** `voidInvoiceAction`
- **QBO call:** `POST /v3/company/{realmId}/invoice?operation=void`
- **Mapping:** just `Id` + `SyncToken`
- **Edge case:** if a payment was already synced, QBO won't allow void
  until the payment is deleted/voided too. Surface this as a clear error
  rather than auto-cascading.

### 4.3 Sync queue

All syncs go through BullMQ. The user-facing action returns immediately.

```ts
// In markInvoicePaidAction, after the DB update:
await qboQueue.add('sync-payment', { tenantId, invoiceId }, {
  attempts: 4,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: 100,
});
```

Worker reads, calls QBO, writes to `qbo_sync_log`. On final failure, posts
an ops card with the payload + error.

---

## 5. Schema Changes

One migration, one new table, three column additions.

```sql
-- 0142_qbo_integration.sql

-- Connection state per tenant
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS qbo_realm_id TEXT,
  ADD COLUMN IF NOT EXISTS qbo_access_token TEXT,
  ADD COLUMN IF NOT EXISTS qbo_refresh_token TEXT,
  ADD COLUMN IF NOT EXISTS qbo_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qbo_connected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qbo_disconnected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qbo_default_item_id TEXT,
  ADD COLUMN IF NOT EXISTS qbo_payment_method_map JSONB;

COMMENT ON COLUMN public.tenants.qbo_realm_id IS
  'QBO company id, populated on OAuth connect.';
COMMENT ON COLUMN public.tenants.qbo_default_item_id IS
  'QBO Item id used for every invoice line in V1. Created on first connect.';
COMMENT ON COLUMN public.tenants.qbo_payment_method_map IS
  'Cached QBO payment method ids per type, e.g. {"cash":"1","cheque":"2",...}';

-- Per-row QBO refs
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS qbo_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS qbo_sync_token TEXT,
  ADD COLUMN IF NOT EXISTS qbo_sync_status TEXT
    CHECK (qbo_sync_status IN ('synced', 'pending', 'failed', 'disabled')),
  ADD COLUMN IF NOT EXISTS qbo_synced_at TIMESTAMPTZ;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS qbo_invoice_id TEXT,
  ADD COLUMN IF NOT EXISTS qbo_payment_id TEXT,
  ADD COLUMN IF NOT EXISTS qbo_sync_token TEXT,
  ADD COLUMN IF NOT EXISTS qbo_sync_status TEXT
    CHECK (qbo_sync_status IN ('synced', 'pending', 'failed', 'disabled')),
  ADD COLUMN IF NOT EXISTS qbo_synced_at TIMESTAMPTZ;

-- Audit log for every sync attempt
CREATE TABLE IF NOT EXISTS public.qbo_sync_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  entity_type     TEXT NOT NULL CHECK (entity_type IN ('customer','invoice','payment','void')),
  entity_id       UUID NOT NULL,
  qbo_id          TEXT,
  status          TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  request_body    JSONB,
  response_body   JSONB,
  error_message   TEXT,
  attempt         INT NOT NULL DEFAULT 1,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS qbo_sync_log_tenant_idx ON public.qbo_sync_log (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS qbo_sync_log_entity_idx ON public.qbo_sync_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS qbo_sync_log_failed_idx ON public.qbo_sync_log (tenant_id, status) WHERE status = 'failed';

ALTER TABLE public.qbo_sync_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY qbo_sync_log_member_select ON public.qbo_sync_log
  FOR SELECT USING (
    tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = auth.uid())
  );
-- Writes only via service role
```

---

## 6. Connection UI

Single page: `/settings/integrations/quickbooks`

**Disconnected state:**
- Hero: "Connect QuickBooks Online"
- One-line value prop: "Push every invoice and payment automatically. Your bookkeeper sees the same numbers you do."
- Big "Connect QuickBooks" button → starts OAuth
- Below: small print on what gets synced and what doesn't

**Connected state:**
- Status pill: "Connected to {company name} · Last synced {timestamp}"
- Last 10 sync events from `qbo_sync_log` (entity, status, when)
- "Sync now" button (kicks a full re-push)
- "Disconnect" with confirm dialog
- Failed-sync section: list of failed rows with retry button each

**Error states:**
- Token expired with refresh failure → red banner: "QuickBooks disconnected — reconnect"
- Mid-sync failure on a specific entity → emerald paid-section on that
  invoice gets a "QBO sync pending — [Retry]" badge

---

## 7. Sync Triggers

Wire into existing server actions, not into a polling loop.

| Action | Add at end |
|---|---|
| `createCustomerAction`, `updateCustomerAction` | enqueue `sync-customer` |
| `sendInvoiceAction` | enqueue `sync-invoice` (chains customer if needed) |
| `markInvoicePaidAction` | enqueue `sync-payment` (chains invoice if needed) |
| Stripe webhook `checkout.session.completed` (invoice marked paid) | enqueue `sync-payment` |
| `voidInvoiceAction` | enqueue `sync-void` |

Each enqueue is best-effort. If the queue is unavailable, log and move on —
the nightly drift-check cron will catch missed syncs.

---

## 8. Error Handling + Retries

- **Transient (5xx, 429, network):** BullMQ retries with exponential
  backoff (2s, 4s, 8s, 16s).
- **Auth (401 with `invalid_token`):** trigger token refresh, retry once.
  If refresh fails, mark tenant disconnected.
- **Permanent (4xx other than 401/429):** log + mark row `qbo_sync_status='failed'`
  + post ops card with the request/response payload.
- **Schema drift (e.g. tax rate mismatch):** clear error message in the
  UI ("HeyHenry tax rate doesn't match your QBO tax setup"), link to docs.

Every failure surfaces in three places:
1. The invoice/customer detail page (red badge with retry button)
2. `/settings/integrations/quickbooks` (failed-sync list)
3. Ops kanban (auto-card via `triage:claude` if it's not a known user-fixable error)

---

## 9. Build Order

| Phase | Scope | Size | Ship-when |
|---|---|---|---|
| **0. Plan + sandbox setup** | Get Intuit Developer account, sandbox company, env vars in Vercel | 1 | Day 1 |
| **1. OAuth flow + connection UI** | `/api/qbo/start`, `/api/qbo/callback`, settings page disconnected/connected states, schema migration | 5 | Day 2-4 |
| **2. Customer push** | Sync action, queue worker, per-row status, e2e test against sandbox | 3 | Day 5-6 |
| **3. Invoice push** | Single-line invoice mapping with GST, void handling | 5 | Day 7-9 |
| **4. Payment push** | All 5 payment methods mapped to QBO PaymentMethodRef, Stripe webhook hookup | 3 | Day 10-11 |
| **5. Error surfacing** | Failed-sync UI, retry buttons, ops card on permanent failure, drift cron | 3 | Day 12-13 |
| **6. End-to-end pass on Jonathan's real QBO trial** | Manual verification with Cathy/bookkeeper | 1 | Day 14 |

Total: ~21 days nominal, ~3 weeks calendar with buffer. Card sized **13 pts**.

---

## 10. Deferred (Fast-follow cards)

Spawn these as separate cards once the V1 card moves to done:

1. **Invoice refund flow + QBO RefundReceipt sync** — needs an invoice-refund
   server action first (we don't have one). ~5 pts.
2. **QBO Item catalog** — push each line item as its own QBO line, with
   per-tenant Item creation/sync. ~5 pts.
3. **Bidirectional sync** — listen to QBO webhooks (CloudEvents format) for
   payments recorded directly in QBO, customer edits, etc. ~8 pts.
4. **Receipt photo attachments** — push payment receipt photos as QBO
   Attachments. ~2 pts.
5. **Token storage migration to Supabase Vault** — before customer #20. ~3 pts.
6. **QBO Payroll Canada hours sync** — separate spec already written. ~13 pts.

---

## 11. Adjacent Cleanup (Surface, Don't Bundle)

The "Integration Critical Gotchas" doc has a Stripe Connect audit checklist
that overlaps with QBO build. Surface as separate cards, don't bundle:

- `stripeAccount` header on every contractor API call — verify
- Connect webhook endpoint separation — verify
- `account.application.deauthorized` handler — verify exists
- `charges_enabled` check before rendering payment links — verify
- Raw body for webhook signature — verify

These are quick audits, ~1 pt each. Likely most are already done — but
worth confirming during the QBO build window since both touch payment
infra.

---

## 12. Open Questions for Jonathan

1. **Default GST rate.** V1 hardcodes 5% Canadian GST. Multi-province
   bookkeeping (HST in Ontario, PST in BC, etc.) — do we need this V1, or
   defer? Recommend defer; surface as fast-follow.
2. **Payment method mapping.** QBO has built-in Cash / Check / Credit Card.
   For e-transfer, do we create a custom "EFT" method in QBO at connection
   time, or map to "Other" and put detail in `PaymentRefNum`? Recommend
   custom method for clarity.
3. **Backfill on connect.** When a GC connects QBO with 50 existing paid
   invoices in HeyHenry, do we push them all retroactively, or sync forward
   only? Recommend: ask the GC, default to forward-only with one-click
   "backfill last 90 days" option.
4. **Bookkeeper notification.** When a sync fails, only the GC sees it
   today. Should we also email the connected QBO account's primary email?
   Probably no for V1 (privacy), but worth flagging.

---

## 13. Done Definition

The QBO V1 card moves to done when:

- [ ] All 13 sandbox e2e tests pass in CI
- [ ] Jonathan ran the full flow against a real QBO 30-day trial with
      Cathy or another bookkeeper reviewing
- [ ] `/settings/integrations/quickbooks` shows connection status, last
      synced, and a failed-sync list
- [ ] Drift-check cron is running nightly and posting ops cards on diffs
- [ ] All 6 fast-follow cards are spawned in backlog with sizes
- [ ] Token-storage-migration card is in backlog with `before-customer-20` tag
- [ ] Stripe Connect audit cards spawned (5 × 1pt)
