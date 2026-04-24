# HeyHenry US Expansion — Plan of Record

Locked decisions as of 2026-04-23. Updated as workstreams ship.

## Bottom line

HeyHenry is Canada-first. MVP launches with Abbotsford (BC) local word-of-mouth + Facebook ads. US expansion is a follow-on sprint, not a parallel track. The codebase is structured so US becomes a 4-6 week focused build — not a multi-sprint retrofit — once a US launch target is set.

## Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Data residency | Single-region (Supabase ca-central-1) for MVP | Canadian hosting is legally fine for US individuals + SMBs (QBO is US-hosted and Canadians use it — the inverse is also true). Multi-region costs real money and the upside is speculative until an enterprise customer asks. |
| US sales tax service | Stripe Tax | Already in the Stripe ecosystem, one fewer vendor, covers nexus + rate lookup + filing reminders. Beats Avalara / TaxJar on integration cost. |
| Currency model | Multi-currency at tenant level | `tenants.currency` field, 'CAD' default. Every `amount_cents` interpreted per tenant currency. No cross-currency FX in HeyHenry itself. |
| Stripe Connect | Country-matched platform + connected | Separate US Stripe platform account for US Connect onboarding (per Stripe's own guidance). |
| Launch sequence | Canada-first, then US as focused sprint | Prove with real customers, then spin up US architecture once. |
| Region columns on every table | No | Over-engineering for a single-region start. Country + currency at the tenant level is enough. Regional sharding is a clean follow-on if ever needed. |

## Architectural prep (shipping now)

These are cheap — one migration + one commit — and pay off forever:

1. **Migration 0103:** `tenants.country` ('CA' default, CHECK 'CA'|'US'), `tenants.currency` ('CAD' default, CHECK 'CAD'|'USD').
2. **TaxProvider factory:** `getTaxProvider(country)` returns `CanadianTaxProvider` for CA, `UsSalesTaxProvider` stub (throws "not yet supported") for US.
3. **PaymentProvider factory:** same pattern, scaffolded but only Canadian Stripe impl present.
4. **`formatCurrency(cents, currency?)`:** accepts currency code, defaults to reading tenant.

Nothing US-specific is built. Just the seams.

## Deferred workstreams (kanban cards — tagged `epic:us-expansion`)

Each lives as its own dev/ops card. Build when launch target for US is set:

- **Trademark clearance + ITU filing** — $300-800 CAD for a professional knockout search, then USPTO + CIPO class 42 ITU filings. Blocker: heyhenry.com is Henry Schein (Fortune 500 medical distributor) — no confirmed "HEY HENRY" TM filing but they have opposition budget. Swiss "Hey Henry AG" is same vertical but no NA nexus. Before US ad spend scales.
- **Stripe platform + Connect onboarding US** — separate US Stripe platform account. Dual webhook routing. Country-matched onboarding.
- **Sales tax via Stripe Tax** — `UsSalesTaxProvider` impl. ZIP-based rate lookup. Line-item category codes. Economic nexus monitoring.
- **A2P 10DLC registration** — Twilio brand + campaign registration for US carrier compliance. Recipient-country-aware messaging service selection.
- **1099-NEC year-end generation** — US equivalent of T4A. Track1099 or Tax1099 API for e-filing.
- **Marketing site country detection + USD pricing** — IP detection, explicit country selector on signup, dual pricing (CAD / USD), US-appropriate trust signals.

## Non-US architecture work still needed before first paying customer

These aren't US-specific but matter regardless — flagged here because they intersect:

- **T4A roll-up + year-end generation pipeline** (Canadian equivalent of the 1099 card). Same table shape (`workers.compliance_kind`).
- **Accountant handoff bundle** (Tier 2 of the overhead expenses epic). Needs to be currency-aware from day one so a US variant is a data swap, not a rebuild.
- **Finalize Canadian backup plan** — already a dependency for first paying customer. Separate card.

## Open questions (not deciding today)

1. **Canadian entity for US sales** — do we need a US LLC? Not strictly required for SaaS but simpler for US sales-tax registration + banking. Revisit when first US customer is close.
2. **SOC 2 Type I** — some US enterprise buyers require it. Skip until a real buyer asks.
3. **Launch pricing** — CAD prices are TBD; USD prices are TBD. Market research due when marketing site work starts.
4. **Payroll integrations** — Wagepoint (CA) and Gusto (US). Both deferred; contractor likely uses one already. Integration work on demand.

## When to revisit this doc

- Before spending USD marketing money (trademark clearance needs to complete first).
- When a US customer meaningfully inquires about signing up.
- When the first CA enterprise customer asks about US data residency (triggers a real multi-region decision).

Updated 2026-04-23 — shipped architectural prep. Next update: when the first of the deferred workstreams goes active.
