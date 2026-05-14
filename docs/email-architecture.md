# HeyHenry Email Architecture

Durable reference for the four-class email system at HeyHenry. Designed to scale to 10k tenants without reputation cross-contamination, and to coexist with Google Workspace on the root domain.

**Sister doc:** [docs/email-templates.md](./email-templates.md) covers the visual + content layer (the `renderEmailShell` standardization, callout/CTA variants, subject-line conventions, CASL category picking, pre-ship verification).

**Last updated:** 2026-05-08
**Status:** Phase 1 partially live (transactional + marketing split exists in code, DNS not fully cut over yet)

## The four classes of email

| Class | Sender domain | Volume estimate (10k tenants) | Reputation poisoning risk |
|---|---|---|---|
| **Corporate (receive)** | `heyhenry.io` (root) — Google Workspace | n/a (inbound only) | Low — but if root domain reputation tanks because we sent from root, our own mail starts going to spam |
| **Transactional** | `mail.heyhenry.io` — Resend | ~10k–50k/month (welcomes, receipts, password resets) | Medium — auth-flow failures hurt revenue directly |
| **Marketing** | `send.heyhenry.io` — Resend | ~50k–500k/month (drip, broadcasts) | High — one campaign can get flagged |
| **Tenant-originated** | `tenants.heyhenry.io` — Resend (Phase 2) | **2M+/month** at 10k tenants | Highest — one tenant's spammy behaviour shouldn't tank everyone |

**The fundamental rule:** never let one class poison another. The way you isolate is subdomains, because each subdomain has its own reputation in inbox-provider eyes (Gmail, Outlook, Apple Mail).

## Target architecture

```
heyhenry.io                    Google Workspace (RECEIVE only)
  ├─ jonathan@heyhenry.io      → real human
  ├─ hello@heyhenry.io         → shared inbox (already advertised on marketing site)
  └─ support@heyhenry.io       → shared inbox

mail.heyhenry.io               Resend (SEND, transactional)
  └─ noreply@mail.heyhenry.io  → auth, welcome, receipts, invoices
                                  reply-to set per-tenant or to hello@

send.heyhenry.io               Resend (SEND, marketing)
  └─ newsletters@send.heyhenry.io → drip, broadcast (CASL-bound)
                                    handled by AR engine in src/lib/ar/

tenants.heyhenry.io            Resend (SEND, tenant-originated) — Phase 2
  └─ noreply@tenants.heyhenry.io → emails our tenants send to THEIR customers
                                    From: "Acme Renos" <noreply@tenants.heyhenry.io>
                                    Reply-To: tenant's contact email
```

## Why each piece matters

**Don't send from root.** Once Google Workspace is on `heyhenry.io`, we can technically send from any address there too (SPF can include both Google and Resend). But a marketing complaint or a spammy tenant on the root domain risks blacklisting `jonathan@heyhenry.io`. Always send from a subdomain.

**Marketing on its own subdomain.** Already in place (`send.heyhenry.io`, used by the AR engine). Spam complaints there don't touch transactional. CASL unsubscribe headers etc. are handled there.

**Tenant-originated on its OWN subdomain.** This is the volume one — at 10k tenants and 200 emails/tenant/month that's 2M+ emails/month. If one tenant blasts 1000 customers with a deal that gets reported, we want that hit to land on `tenants.heyhenry.io`, not `mail.heyhenry.io` where password-reset emails live. Currently NOT split — every tenant-sent email goes through the transactional path (FROM_EMAIL). This is fine at 10 tenants, dangerous at 1k.

## Current state (2026-05-08)

**Code is ready for the split:**
- `src/lib/email/client.ts` exports `FROM_EMAIL` (transactional) and `FROM_EMAIL_MARKETING`
- Reads `RESEND_FROM_EMAIL_TRANSACTIONAL` and `RESEND_FROM_EMAIL_MARKETING` env vars
- Falls back to legacy `RESEND_FROM_EMAIL` for compatibility during cutover

**DNS / env not fully cut over:**
- Production `RESEND_FROM_EMAIL=noreply@heyhenry.io` (root domain)
- Verified Resend domain is currently the root `heyhenry.io`
- `mail.heyhenry.io` and `send.heyhenry.io` not yet verified in Resend (or DNS not configured)
- `tenants.heyhenry.io` doesn't exist yet (Phase 2)
- Google Workspace not yet set up

## Phased rollout plan

### Phase 1 — Transactional + Marketing split (kanban [c88f3fb1](https://ops.heyhenry.io/admin/kanban/dev))

**Owner: ops (DNS work) + dev (env vars)**

DNS records to add at the heyhenry.io DNS host (Cloudflare or wherever):
- `mail` subdomain:
  - `TXT mail "v=spf1 include:_spf.resend.com ~all"`
  - `TXT resend._domainkey.mail "<DKIM key from Resend dashboard>"`
  - (Optional) `MX mail` records for bounce-routing if you want to handle bounces actively
- `send` subdomain:
  - `TXT send "v=spf1 include:_spf.resend.com ~all"`
  - `TXT resend._domainkey.send "<DKIM key from Resend dashboard>"`
- Root domain DMARC (covers all):
  - `TXT _dmarc "v=DMARC1; p=none; rua=mailto:dmarc@heyhenry.io; pct=100"`
  - Set `p=none` initially for monitoring; tighten to `p=quarantine` after 30 days of clean reports

Resend dashboard:
- Add `mail.heyhenry.io` as a verified domain
- Add `send.heyhenry.io` as a verified domain
- Wait for green checkmarks on SPF/DKIM

Vercel env vars:
- `RESEND_FROM_EMAIL_TRANSACTIONAL=noreply@mail.heyhenry.io`
- `RESEND_FROM_EMAIL_MARKETING=newsletters@send.heyhenry.io` (or whatever local-part you choose)
- (Don't remove `RESEND_FROM_EMAIL` yet — keep as fallback during cutover)

Verification:
- Send a test transactional email, inspect headers in Gmail (View original → check SPF: PASS, DKIM: PASS)
- Send a test marketing email same checks

After 1 week of clean sends and zero deliverability regressions:
- Remove the legacy `RESEND_FROM_EMAIL` env var
- Update `client.ts` fallback chain to drop the legacy reference

### Phase 2 — Tenant-originated subdomain (kanban TBD, Phase 2 card)

**Owner: dev**

Trigger: when active-tenant count crosses ~50, OR when a single tenant starts sending more than 5k emails/month. Either signal means tenant volume is large enough that mixing it with transactional is risky.

DNS:
- Add `tenants.heyhenry.io` SPF + DKIM records (same shape as Phase 1)
- Verify in Resend

Code:
- Add `FROM_EMAIL_TENANT` constant to `src/lib/email/client.ts`
- Add `RESEND_FROM_EMAIL_TENANT` env var
- Update `getTenantFromHeader()` in `src/lib/email/from.ts` to use `tenants.heyhenry.io` for the from-address (with tenant's display name and reply-to set to their `contact_email`)
- Audit every callsite of `sendEmail` — categorize as transactional / marketing / tenant-originated, route to the right FROM constant

### Phase 3 — Dedicated IPs + sharding (when needed)

**Owner: dev + ops**

Trigger: when shared IP volumes start showing reputation flags, or any single domain crosses ~100k/day.

- Move `tenants.heyhenry.io` to a dedicated IP pool in Resend
- Move `mail.heyhenry.io` to a dedicated IP pool (separate from tenants)
- If a major tenant starts dominating volume, shard tenant subdomain to `t1.heyhenry.io`, `t2.heyhenry.io`, etc.

This is a "we'll know when we get there" phase. Resend has dedicated IPs at higher tiers; SendGrid/Postmark same. Don't over-engineer until reputation actually shows signs of stress.

## Google Workspace coexistence

Google Workspace receives mail on the root domain via MX records. It does NOT conflict with our Resend sending because:
- Sending uses subdomains (`mail.*`, `send.*`, `tenants.*`) — no MX records needed there
- SPF/DKIM/DMARC for the root domain are Google-only
- SPF/DKIM/DMARC for the subdomains are Resend-only

Setup steps for Google Workspace (kanban [9360c1c8 ops board](https://ops.heyhenry.io/admin/kanban/ops) — extend or spawn new):
- Sign up for Google Workspace at the heyhenry.io domain
- Add MX records pointing to Google
- Set up SPF + DKIM + DMARC for Google
- Create `jonathan@`, `hello@`, `support@` mailboxes (or routing groups)
- Test inbound delivery: send an email to `hello@heyhenry.io` from an external account, confirm it lands in the Workspace inbox

## What NOT to do

- **Never put Google Workspace on a sending subdomain** — keeps reputation isolated
- **Never send from root domain** in production code — even if Google Workspace SPF includes Resend (it doesn't by default), we want isolation
- **Never reuse `noreply@` across subdomains** for different classes — each class needs its own from-address so unsubscribe and reply behaviour is class-appropriate

## Open questions for future work

- **Bounce handling**: Resend reports bounces but we currently don't act on them (no `email_bounced_at` flag on tenants). Add when bounce volume becomes a real signal.
- **Reply routing for `noreply@mail.*`**: today these emails have reply-to set per-tenant. For our own auth/welcome emails (no tenant context), reply-to is `hello@heyhenry.io`. Want to formalize this in the welcome email helper.
- **Inbound parsing**: do we need to receive email at any subdomain (e.g., for inbound estimate-request parsing)? If so, set up MX on that subdomain pointing at our inbound webhook (Resend or SendGrid Inbound Parse).
