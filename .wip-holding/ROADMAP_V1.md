# HeyHenry v1 Roadmap — Public Soft Launch

<!-- STATUS: DRAFT PROPOSAL — awaiting Jonathan review | 2026-04-22 -->

**v1 definition:** Public-ready soft launch. Anyone can sign up, pay, and run their contractor business on HeyHenry without Jonathan babysitting. Precedes broader marketing push.

**Assumed audience at launch:** small trade contractors (pressure washing + renovation first), English-speaking, Canada. Marketing push to non-founding verticals comes after v1.

**Private beta (running now):** Will (pressure washing), JVD/Connect Contracting (renovation). Feedback from these two drives what lands in v1 vs post.

**This doc is the source of truth.** Once approved, items are seeded into `ops.roadmap_lanes` + `ops.roadmap_items` and the `/roadmap` page renders them. Edits after seeding happen in the DB, not here — this doc gets a "sealed" header on launch day.

---

## Lane 1 — Product Core (gaps in the core app)

Most of the app is built. These are the unfinished pieces of SPEC-v1's required features.

- [x] Auth + multi-tenancy + RLS isolation *(v0.1.0-foundation, 2026-04-16)*
- [x] Customers + quotes + jobs + invoices (pressure washing) *(GC_WORKFLOW Stages 1–6)*
- [x] Projects + estimates + change orders + progress invoicing (renovation)
- [x] Time + expense logging with receipt OCR
- [x] AI text chat (Claude, 17 tools)
- [x] Voice Henry — web (Gemini Live, push-to-talk, tool execution)
- [x] Biweekly customer progress reports (renovation, approval queue)
- [x] Photos v1 (upload, tag, gallery, RLS)
- [ ] **Worker app UI** — schema done (0051–0057), web shell at `/w/*` needs calendar, expense entry, invoice generation, assignment list. *(Blocker: JVD crew can't self-serve without it.)*
- [ ] **Universal intake — PDFs + receipts** — screenshots/photos shipped; PDF routing and receipt artifact type unfinished.
- [ ] **Onboarding wizard** — first-login: pick vertical, seed catalog, invite team, create first customer. Today users land on an empty dashboard.

## Lane 2 — Commerce (SaaS billing, pricing, signup)

HeyHenry currently makes $0. Must be able to charge before public launch.

- [ ] **Pricing model finalized** — tiers + overage. HEY_HENRY_APP_PLAN.md proposes $99–$499/mo + metered voice; needs sign-off.
- [ ] **Stripe Billing integration** — subscriptions on the HeyHenry side (distinct from the existing Stripe Connect for operator → customer payments).
- [ ] **Free trial or freemium flow** — decide model, gate features at trial end.
- [ ] **Metered voice + AI token caps** — cap usage per plan, soft-warn at 80%, hard-block at 100%.
- [ ] **Subscription self-service** — upgrade/downgrade/cancel in-app, no support ticket needed.
- [ ] **Vertical selection at signup** — pressure washing vs renovation (affects catalog seed, UI labels, default report cadence).

## Lane 3 — Trust & Safety (compliance, data, security)

Anything that becomes a crisis post-launch if missing.

- [ ] **Backups Phase 1** — PITR enabled on Supabase, nightly `pg_dump` → encrypted off-platform storage, restore drill documented. *(BACKUPS_PLAN.md marks this as critical debt before first paying customer.)*
- [ ] **Owner MFA (TOTP)** — enrollment flow, recovery codes, sensitive-action re-challenge. MFA_PLAN.md exists but no code.
- [ ] **Privacy policy + Terms of Service** — public pages, versioned, accept-on-signup.
- [ ] **DPA template** — linked from ToS, covers tenant data processing.
- [ ] **Account deletion flow** — PIPEDA requirement; self-service data export + tenant delete.
- [ ] **Uptime monitoring** — external checker on `/api/health`, pages Jonathan on failure.
- [ ] **Error tracking (Sentry)** — capture server + client errors, release tagging.
- [ ] **Email deliverability verified** — SPF/DKIM/DMARC live on both `mail.heyhenry.io` and `send.heyhenry.io`, reputation warmed.
- [ ] **Support inbox** — `support@heyhenry.io` routed somewhere Jonathan actually reads.

## Lane 4 — Marketing Readiness (heyhenry.io + launch comms)

The public-facing surface that converts visitors into signups.

- [ ] **Landing page at heyhenry.io** — hero, feature sections, social proof (even if just Will + JVD quotes), pricing teaser, signup CTA.
- [ ] **Pricing page** — tier comparison, FAQ, CTA.
- [ ] **Feature tour / explainer video** — 90-second Henry-voice demo.
- [ ] **Blog / SEO baseline** — 3–5 foundational posts (contractor pain points, Henry intro, case study of Will or JVD).
- [ ] **Email nurture sequence** — signup → day 1, 3, 7, 14 via existing autoresponder. Templates to write.
- [ ] **Launch email to existing network** — Jonathan's list: "we're open, come in."
- [ ] **Social presence stub** — HeyHenry Twitter/LinkedIn/YouTube accounts, linked from site.

## Lane 5 — Ops (HeyHenry's own operating system)

Runs in parallel. The roadmap page itself lives here.

- [x] Ops subdomain live (`ops.heyhenry.io/api/ops/health` → 200)
- [x] Worklog API (signed HMAC, agent-ready)
- [x] OPS Phase 0 schema + middleware + admin gate
- [ ] **Roadmap module** — `ops.roadmap_lanes` + `ops.roadmap_items` migration, seed from this doc, `/roadmap` page with per-lane progress bars + overall meter.
- [ ] **Kanban for task-level work** — separate module; roadmap items can link to one-or-more kanban cards. Meter can optionally auto-advance as linked cards close (post-v1 nicety).
- [ ] **Ideas + decisions modules** — Phase 1 per OPS_PLAN.md. Not v1-blocking but low-effort and high-leverage.

---

## Explicitly NOT in v1

Listed here so they don't sneak back in:

- **Native iOS/Android (Expo) Henry app** — web voice is sufficient for soft launch.
- **Photo intelligence Phase 2+** — Claude Vision auto-tagging, closeout reports.
- **Customer portal + share links** — operator emails PDFs for now.
- **Multi-region infra stand-up** — CA-only at launch; Terraform for second region comes when first non-CA customer signs up.
- **Admin autoresponder UI** — engine works; Jonathan configures via MCP tools / SQL.
- **Referrals (sweepstakes + customer referrals)** — post-v1 growth lever.
- **Maintenance agent (weekly cron)** — nice-to-have; manual review works at soft-launch scale.
- **Knowledge vault + embeddings** — OPS_PLAN Phase 3.
- **QuickBooks integration, aerial quoting, cross-project AI, tile vertical, Tap to Pay.**

---

## Progress meter rules (for the ops page)

- Each lane has a **% complete** = `done_items / total_items`.
- Overall v1 meter is the **weighted average** of lanes, with weights reflecting Jonathan's priority (defaults to equal until you tune).
- Items are binary (done/not done) in v1. No in-progress %. Keeps the math honest.
- An item only flips to "done" when an acceptance criterion is met — not when code lands. Examples:
  - "Backups Phase 1" done = restore drill completed successfully, documented.
  - "Landing page" done = live at heyhenry.io, not just in a branch.
  - "Stripe Billing" done = a test customer has been charged end-to-end.

---

## Open questions before seeding

1. **Pricing model** — is `$99 / $199 / $499` still the plan, or revisit?
2. **Trial vs freemium** — 14-day trial + card-on-file, or forever-free with paid upgrades?
3. **Lane weighting** — do some lanes count more than others in the overall meter? (Recommend: equal to start.)
4. **Launch date target** — pick a date to anchor; roadmap page shows days remaining.
5. **Anything missing** — what did I drop that should be v1?
