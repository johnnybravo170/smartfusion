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

## 1.5 Strategic line — what HeyHenry is NOT

The integration only works if HH has a clear lane. **HH is the operational
truth — what happened in the business. QBO is the bookkeeper's truth — what
the books say.** HH captures rich operational data (estimates, projects,
expenses, time, owner draws) and pushes clean transactions to QBO. HH never
tries to *be* the GL.

This means a hard NO on the following, no matter how often they get
suggested:

- **Don't replicate the QBO ledger inside HH.** Bank statement import is a
  *payment-mark assist* — it matches bank lines to existing invoices /
  expenses / bills so the GC doesn't manually mark each one paid. The
  unmatched pile (transfers, fees, interest) is QBO's problem, not ours.
- **Don't push bank_transactions themselves to QBO.** They're an HH-internal
  cache for matching. QBO has its own bank feed — duplicating it would just
  cause reconciliation conflicts.
- **Don't build a multi-account ledger, balance-forwarding, or "reconcile
  this account" reports.** Bookkeeper-grade work; needs accounting standards
  HH doesn't have.
- **Don't add a real chart of accounts in HH.** The existing
  `coa-mapping.ts` is a *mapping table* against the bookkeeper's QBO chart.
  Keep it that way; do not expand into a real COA.
- **Don't add tax categorization on owner draws.** Salary vs dividend has
  tax consequences resolved at year-end by the accountant. HH records the
  operator's intent ("paid $X as salary on Y date"); the JE we push reflects
  that. The accountant adjusts on close.
- **Don't add journal-entry editing in HH.** Owner draws and similar are
  *facts* in HH that become journal entries on push. Edit the fact, not the
  JE.
- **Don't add tax-return outputs (T2125, GST/HST returns, year-end close,
  retained earnings, T4s, T5s).** These are QBO's job and the accountant's
  job. Building them = competing with QBO on its home turf, requiring AICPA
  / CPA Canada compliance HH will never own.

If a feature ask doesn't fit the operational-truth lane, it goes to the QBO
bridge instead — model it as a new sync target rather than a new HH module.
Bookkeepers staying happy is a top-3 retention lever.

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
| 5 | Create invoice with 5 line items + tax-exempt | QBO Invoice with 5 lines, `TaxCodeRef` = tax-exempt code, no tax |
| 5b | Invoice for BC customer (GST+PST) | QBO Invoice with `TaxCodeRef`=`GST/PST BC`, total tax = 12% of subtotal |
| 5c | Invoice for ON customer (HST) | QBO Invoice with `TaxCodeRef`=`HST ON`, total tax = 13% |
| 5d | Invoice for AB customer (GST only) | QBO Invoice with `TaxCodeRef`=`GST`, total tax = 5% |
| 5e | Invoice with customer missing province | Sync blocked, clear UI error: "Province needed before QBO sync" |
| 5f | Invoice for tenant whose QBO is missing the right TaxCode | Sync blocked, actionable error pointing to QBO Sales Tax settings |
| 6 | Mark invoice paid via Stripe | QBO Payment linked to invoice, `PaymentMethodRef`=Credit Card |
| 7 | Mark invoice paid via cheque (record-payment dialog) | QBO Payment, `PaymentMethodRef`=Check, reference field populated |
| 8 | Mark invoice paid via cash | QBO Payment, `PaymentMethodRef`=Cash |
| 9 | Mark invoice paid via e-transfer | QBO Payment, `PaymentMethodRef`=Other (or custom EFT method) |
| 10 | Void an invoice | QBO Invoice voided (not deleted) |
| 11 | Sync fails (force token revocation mid-test) | `qbo_sync_log.status='failed'`, retry button surfaces, ops card created, **failure email goes to the actor who triggered it** (GC if invoice send, bookkeeper if portal retry) |
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
    "Construction services" item created on first connection
  - `Line[0].SalesItemLineDetail.TaxCodeRef.value` ← TaxCode id from
    `tenants.qbo_tax_code_map[customer.province]` (or `_tax_exempt` for
    exempt customers). See §12.1 for the province → TaxCode lookup.
  - `Amount` ← `invoice.amount_cents + sum(line_items)` (pre-tax)
  - `DocNumber` ← short invoice id `inv-{first8}`
  - `PrivateNote` ← internal note ("Synced from HeyHenry — invoice {full id}")
  - `CustomerMemo` ← `invoice.customer_note` if present
- **Tax verification:** after the invoice is created, read back the QBO
  response and assert `TxnTaxDetail.TotalTax * 100 ≈ invoice.tax_cents`
  within ±$0.02. Mismatch logs a `tax_mismatch` warning + posts an ops
  card; sync still succeeds (QBO is the source of truth for the
  bookkeeper).
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
await qboQueue.add('sync-payment', {
  tenantId,
  invoiceId,
  actor: { kind: currentActor.kind, userId: currentActor.userId, email: currentActor.email },
}, {
  attempts: 4,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: 100,
});
```

The `actor` is whoever triggered the action — `kind` is `'gc'`, `'bookkeeper'`,
or `'system'` (cron-driven). The worker calls QBO, writes to `qbo_sync_log`.
On final failure it emails `actor.email` directly (so bookkeeper-triggered
syncs notify the bookkeeper, GC-triggered notify the GC) and posts an ops
card. `kind='system'` cron failures route to the GC.

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
  ADD COLUMN IF NOT EXISTS qbo_payment_method_map JSONB,
  ADD COLUMN IF NOT EXISTS qbo_tax_code_map JSONB;

COMMENT ON COLUMN public.tenants.qbo_realm_id IS
  'QBO company id, populated on OAuth connect.';
COMMENT ON COLUMN public.tenants.qbo_default_item_id IS
  'QBO Item id used for every invoice line in V1. Created on first connect.';
COMMENT ON COLUMN public.tenants.qbo_payment_method_map IS
  'Cached QBO payment method ids per type, e.g. {"cash":"1","cheque":"2","e-transfer":"7",...}';
COMMENT ON COLUMN public.tenants.qbo_tax_code_map IS
  'Per-province QBO TaxCode ids, e.g. {"BC":"4","ON":"8","_tax_exempt":"3"}';

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
  -- Who triggered this sync. Determines who gets the failure email.
  actor_kind      TEXT NOT NULL CHECK (actor_kind IN ('gc','bookkeeper','system')),
  actor_user_id   UUID,
  actor_email     TEXT,
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
| **1. OAuth flow + connection UI** | `/api/qbo/start`, `/api/qbo/callback`, settings page disconnected/connected states, schema migration, post-connect TaxCode + PaymentMethod fetch + map population | 5 | Day 2-4 |
| **2. Customer push** | Sync action, queue worker, per-row status, e2e test against sandbox | 3 | Day 5-6 |
| **3. Invoice push** | Single-line invoice mapping with multi-province TaxCode lookup, tax-mismatch warnings, void handling | 5 | Day 7-9 |
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
7. **Owner draws → QBO `JournalEntry` push.** Each new `owner_draws` row
   becomes a journal entry: debit Owner's Equity (or Shareholder Loan,
   depending on entity type), credit the operating bank account. Mapping is
   per-tenant and one-time during onboarding. Includes draw_type in
   `PrivateNote` for the bookkeeper. The accountant adjusts the equity vs
   loan classification at year-end — HH records the fact, not the tax
   treatment. ~5 pts.
8. **Bank-import payment-confirm → existing Payment sync.** When a bank
   transaction is matched to an unpaid invoice and the GC confirms in the
   review queue, the existing `markInvoicePaidAction` fires — which already
   triggers the §4.2 Payment push to QBO. **No new sync code needed**, but
   verify the chain end-to-end on first bank-recon launch. ~1 pt (verification
   only).

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

## 12. Decisions (resolved 2026-04-26)

1. **Tax handling — full Canadian multi-province support in V1.**
   BC will be the bulk of early customers, but tax behavior needs to be
   correct for every customer regardless of province. Detail in §12.1.
2. **e-Transfer payment method.** Create a custom "EFT" payment method in
   QBO at connection time. Map `payment_method='e-transfer'` → that
   custom method id. Cleaner than dumping detail in `PaymentRefNum`.
3. **Backfill on connect.** Default to forward-only with a one-click
   "backfill last 90 days" option visible right after connection.
4. **Sync notifications — actor-based routing.** Whoever triggered the
   action gets the email. If a bookkeeper retries a failed sync from inside
   the bookkeeper portal, the failure email goes to them. If the GC sends
   an invoice (which auto-syncs) and it fails, the failure email goes to
   the GC. We already know who's logged in. No opt-in field, no inferring
   third parties from OAuth, no privacy puzzle. This applies to every
   sync-related email, not just failures.

### 12.1 Multi-province tax mapping

Canadian provincial sales tax is messy. We already compute the right
`tax_cents` per invoice via `canadianTax.getContext(tenantId)` (driven by
the customer's province). What QBO needs additionally is the **TaxCode**
to apply on the line — QBO computes tax itself from the code, and bookkeepers
care that the right code shows up so their reports are clean.

**Provincial reality (rates as of 2026):**

| Province | Composition | QBO TaxCode (built-in name) |
|---|---|---|
| BC | GST 5% + PST 7% | `GST/PST BC` |
| AB, NT, NU, YT | GST 5% | `GST` |
| SK | GST 5% + PST 6% | `GST/PST SK` |
| MB | GST 5% + RST 7% | `GST/RST MB` |
| QC | GST 5% + QST 9.975% | `GST/QST QC` |
| ON | HST 13% | `HST ON` |
| NB, NL, NS, PE | HST 15% | `HST` (province-specific built-in) |
| Out-of-Canada / zero-rated | 0% | `Zero-rated` or `Out of scope` |

**Implementation:**

- On connection, fetch the tenant's QBO TaxCodes via
  `GET /v3/company/{realmId}/query?query=SELECT * FROM TaxCode`
- Build a `qbo_tax_code_map` JSONB on `tenants` keyed by province code:
  `{ "BC": "<id>", "ON": "<id>", "AB": "<id>", ... }`
- For each invoice push:
  1. Derive tax province: prefer `customer.province`, fall back to
     `tenant.province` (operators based in BC servicing BC customers
     hit this hot path)
  2. Look up the TaxCode id from the map
  3. Set `Line[i].SalesItemLineDetail.TaxCodeRef.value` to that id
  4. Trust QBO's computed tax — but assert that QBO's `TxnTaxDetail.TotalTax`
     matches our `invoice.tax_cents` within $0.02. If not, log a
     `qbo_sync_log` row with `status='succeeded'` but `warning='tax_mismatch'`
     and post an ops card. Don't block the sync.

- If the customer has no province set: surface a warning in the dialog
  ("Province needed before QBO sync — defaults to {tenant province}").
  Don't silently guess.

- **Tax-exempt customers** (`customers.tax_exempt=true`): map to QBO's
  built-in "Out of scope" or "Zero-rated" TaxCode (decided per-tenant on
  first tax-exempt sync). Same `qbo_tax_code_map` extended with a
  `_tax_exempt` key.

- **Tenant doesn't have the right TaxCodes set up in QBO** (e.g. just-
  signed-up GC who only has `GST` because Intuit didn't provision provincial
  combos): surface an actionable error: "QBO is missing the BC PST tax
  code. Create it in QBO Settings → Sales Tax, then click Reconnect Tax
  Codes here." Don't auto-create — too risky to mess with someone's tax
  setup.

**Out of scope for V1 (fast-follows):**
- Quebec QST registration (separate registration from federal GST)
- US sales tax (handled by separate US Stripe Tax integration card)
- Cross-border invoices (different rules entirely)

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
