# Referrals — Sweepstakes + Customer-Level Referrals

**Date:** 2026-04-20
**Status:** Plan — not started.

Builds on existing tenant-to-tenant referral system (migrations 0024–0026, `src/server/actions/referrals.ts`, `/referrals`, `/r/[code]`).

---

## 1. Tenant-referral sweepstakes

**Why:** Housecall Pro's $5k sweepstakes is the single biggest lift they get on SaaS referrals. Flat per-referral rewards are table-stakes; a sweepstakes adds a second, asymmetric motivator (small chance of a big prize) on top of the existing reward without raising per-referral payout.

**How it layers on what exists:** each qualifying referral (status advances to `signed_up` or `converted`, configurable) automatically grants N entries into the currently-active sweepstakes. No separate opt-in.

### Schema

```sql
-- 00NN_sweepstakes.sql

CREATE TABLE public.sweepstakes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  prize_description TEXT NOT NULL,    -- "$5,000 cash", "iPad Pro", etc.
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  -- Which referral milestone grants entries.
  entry_trigger TEXT NOT NULL DEFAULT 'signed_up'
    CHECK (entry_trigger IN ('signed_up', 'converted')),
  entries_per_referral INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'ended', 'drawn')),
  winner_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  drawn_at TIMESTAMPTZ,
  rules_url TEXT,                     -- link to legal terms PDF
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.sweepstakes_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sweepstakes_id UUID NOT NULL REFERENCES sweepstakes(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  referral_id UUID NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sweepstakes_id, referral_id)  -- one referral = one grant event
);
CREATE INDEX ON sweepstakes_entries (sweepstakes_id, tenant_id);
CREATE INDEX ON sweepstakes_entries (tenant_id);

ALTER TABLE public.sweepstakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sweepstakes_entries ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read active/ended sweepstakes metadata.
CREATE POLICY authenticated_select_sweepstakes ON sweepstakes
  FOR SELECT TO authenticated
  USING (status IN ('active', 'ended', 'drawn'));

-- Tenants can see their own entries.
CREATE POLICY tenant_select_entries ON sweepstakes_entries
  FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id());
```

### Entry-grant logic

In `src/server/actions/referrals.ts`, when a referral transitions to the configured `entry_trigger` status, for every `sweepstakes` row where `status='active'` and `now() BETWEEN starts_at AND ends_at`, insert `entries_per_referral` rows into `sweepstakes_entries`. Wrap in the same transaction as the status update so we can't half-grant.

Backfill note: when a new sweepstakes goes `active`, do NOT retroactively grant entries for past qualifying referrals — keep it forward-looking so the contest drives new behavior.

### Draw

Admin-only action on `/admin/sweepstakes/[id]`: `SELECT ... ORDER BY random() LIMIT 1`, set `winner_tenant_id` + `drawn_at`, status → `drawn`. Send winner email + post to `/admin` activity log. Manual notification is fine for v1 (no automated cash payout).

### Surfaces

- **Operator `/referrals` page:** banner at top — "Active sweepstakes: $5,000 cash. You have 7 entries. Ends May 31." Pulled from `sweepstakes` + count of the operator's entries in the active row.
- **Admin `/admin/sweepstakes`:** list, create, start/end, draw winner, view entries leaderboard.
- **Public rules page:** `/sweepstakes/[id]/rules` rendering `rules_url` content or a templated page. Required for legal compliance in BC / most US states — no purchase necessary, alt method of entry, odds disclosure.

### Legal gotchas (flag before shipping)

1. **No purchase necessary** — must provide a free entry method (e.g., mail-in or a non-referral action). Add `alt_entry_method TEXT` column if going this route, or link to an email-in form on the rules page.
2. **Jurisdictions:** void in Quebec (requires RACJ registration + fee), and several US states (NY, FL, RI) have registration thresholds when prize value exceeds a certain amount. For a $5k prize we're under NY/FL thresholds but need to double-check.
3. **Odds disclosure:** rules page must state how winners are selected and approximate odds.
4. **Record-keeping:** keep `sweepstakes_entries` + the RNG seed used for the draw for 3 years.

Do not ship without Jonathan reviewing the rules template. Put the legal question in DECISIONS.md.

### Phases

- **S1 — Schema + entry grant** (~0.5 day). Migration, hook into existing referral status updater, unit test asserts N entries created when referral → `signed_up`.
- **S2 — Operator banner** (~0.25 day). Read active sweepstakes, show entry count on `/referrals`.
- **S3 — Admin create/draw** (~0.5 day). `/admin/sweepstakes` list + form + draw action. Winner email template.
- **S4 — Rules page + alt entry** (~0.5 day). Public route, rules content, alt-entry submission form. Ship this BEFORE S3 is marketed externally.

---

## 2. Customer-level referrals (operator → homeowner → new homeowner)

**Why:** This is the one JVD would use every week. Jobber gates it behind their $79/mo Marketing Suite. Shipping it in the base plan is a real competitive wedge, not a me-too feature.

**Shape:** operator configures a referral reward (flat $ or %) → customer gets a unique link + code → when a referred person becomes a customer and is invoiced, the referring customer earns a credit that auto-applies to their next invoice.

### Schema

```sql
-- 00NN_customer_referrals.sql

-- Tenant-level referral program config (one row per tenant).
CREATE TABLE public.customer_referral_programs (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  reward_type TEXT NOT NULL DEFAULT 'fixed'
    CHECK (reward_type IN ('fixed', 'percent')),
  reward_amount_cents INTEGER,          -- when reward_type='fixed'
  reward_percent NUMERIC(5,2),          -- when reward_type='percent' (e.g. 10.00)
  -- What triggers the reward. 'first_invoice_paid' is the safe default.
  trigger_event TEXT NOT NULL DEFAULT 'first_invoice_paid'
    CHECK (trigger_event IN ('first_invoice_paid', 'first_invoice_sent', 'quote_accepted')),
  -- Cap per referrer per year so a viral chain can't bankrupt the operator.
  max_rewards_per_referrer_per_year INTEGER NOT NULL DEFAULT 10,
  headline TEXT,                        -- "Give $50, get $50"
  terms TEXT,
  expires_days INTEGER,                 -- credit expiry window; NULL = no expiry
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-customer referral code.
CREATE TABLE public.customer_referral_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,            -- short nanoid; shown to the customer
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, customer_id)
);
CREATE INDEX ON customer_referral_codes (tenant_id);

-- Referral events.
CREATE TABLE public.customer_referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  referrer_customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  referred_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  referred_lead_email TEXT,             -- captured before they become a customer
  referred_lead_name TEXT,
  source TEXT NOT NULL DEFAULT 'link'
    CHECK (source IN ('link', 'manual', 'quote_form')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'converted', 'rewarded', 'expired', 'voided')),
  reward_credit_cents INTEGER,          -- captured at award time for audit
  converted_at TIMESTAMPTZ,
  rewarded_at TIMESTAMPTZ,
  trigger_invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON customer_referrals (tenant_id, status);
CREATE INDEX ON customer_referrals (referrer_customer_id);

-- Credit ledger on the referring customer. Applied to next invoice.
CREATE TABLE public.customer_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,        -- positive = credit available
  remaining_cents INTEGER NOT NULL,     -- drawn down as invoices apply
  source TEXT NOT NULL
    CHECK (source IN ('referral', 'manual_adjustment', 'refund')),
  source_referral_id UUID REFERENCES customer_referrals(id) ON DELETE SET NULL,
  note TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON customer_credits (tenant_id, customer_id) WHERE remaining_cents > 0;
```

RLS: tenant isolation on all four, same pattern as existing tables. Public SELECT on `customer_referral_codes` for the anon landing page (`/rc/[code]`).

### Flows

**Operator setup** (`/settings/referrals`): toggle enable, choose fixed vs percent, set amount, set trigger, write headline + terms. Save writes to `customer_referral_programs`.

**Code generation:** on first enable, backfill a `customer_referral_codes` row for every existing customer. On new customer create, insert a code. Show the code + a "Share" button on the customer detail page.

**Customer sharing surface:** later — when we add a client portal, each customer sees `/portal/[customer_slug]/refer`. For v1, operator copies the link from the customer page and texts/emails it themselves.

**Landing page** `/rc/[code]`: public. Shows "{Customer name} recommends {Tenant business name}" + headline + a lead-capture form (name, email, phone, description of job). POST creates a `customer_referrals` row with `source='link'` status `pending` and a `leads` row tied to the tenant.

**Conversion + reward** (in existing invoice server action): after an invoice transitions per `trigger_event` (e.g., first invoice paid), find the referred customer's `customer_referrals` row where status='converted' and `referred_customer_id` matches, flip to `rewarded`, insert a `customer_credits` row on the referrer with `amount_cents` (or computed from `reward_percent * invoice.subtotal_cents`). Respect `max_rewards_per_referrer_per_year` — if exceeded, mark `voided` with a note.

**Credit application:** when creating/sending an invoice, check `customer_credits.remaining_cents > 0 AND (expires_at IS NULL OR expires_at > now())` for the bill-to customer. Auto-add a line item "Referral credit" with a negative amount capped at the invoice subtotal. Decrement `remaining_cents`. Log the application (either a new `customer_credit_applications` join table or inline in invoice JSONB; recommend the join table).

**Operator surfaces:**
- `/referrals` gets a second tab: "Customer program" showing counts (pending, converted, rewarded, credits outstanding) + a list.
- Customer detail page: referral code + history of referrals sent and credits earned/applied.
- Invoice detail: credit applied badge.

### Phases

- **C1 — Schema + program config UI** (~1 day). Migration, `/settings/referrals` form, RLS tests.
- **C2 — Per-customer code generation + share link** (~0.5 day). Backfill existing customers, add code to customer detail page, copy-link button.
- **C3 — Public `/rc/[code]` landing + lead capture** (~0.75 day). Lead row creation, referral row creation. Reuse existing lead-intake styling.
- **C4 — Conversion detection + credit issuance** (~1 day). Hook into invoice status transitions, respect annual cap, write `customer_credits`.
- **C5 — Credit application on invoices** (~0.75 day). Auto-apply on invoice compose, decrement remaining, show on invoice PDF.
- **C6 — Operator dashboards** (~0.5 day). `/referrals` customer tab, customer-detail referral history, basic analytics (rewards paid YTD).
- **C7 — Portal self-serve (optional)** (~0.5 day). Once customer portal exists, expose the code + share buttons there.

### Open decisions

1. **Percent basis.** Percent of invoice subtotal, or first-year revenue from the referred customer? Jobber uses the next-invoice model (simple). Recommend subtotal of the trigger invoice only — simplest, least argument.
2. **Stacking.** Can a customer earn multiple credits before applying any? Yes — the ledger handles it; cap is per-year not per-outstanding.
3. **Expiry.** Default credit expiry 365 days. Operators can override to "never" with `expires_days = NULL`.
4. **Refunds.** If the trigger invoice is refunded, do we claw back the credit? v1: no (mark as manual reconciliation). Flag for v2.
5. **Tax.** Credit reduces invoice subtotal, which means GST is charged on the lower amount. Confirm with JVD's accountant this is acceptable — typically yes for credits-as-discounts, no for prepayments.

---

## Build order vs GC workflow

Both independent of GC workflow stages. Recommend inserting after Stage 4 (change orders) in GC plan — by then the operator has the muscle memory of the app and a referral-worthy experience to share. Do sweepstakes (S1–S4) first since it's ~1.75 days and builds on existing plumbing; customer-level referrals (C1–C6) is ~4.5 days and net-new surface.
