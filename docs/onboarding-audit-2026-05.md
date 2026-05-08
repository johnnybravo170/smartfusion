# Customer-#1 Onboarding Audit — May 2026

Walkthrough of every customer-facing touchpoint from `heyhenry.io` first-click through dashboard day-1, captured 2026-05-08 after Mike's signup attempt exposed multiple polish gaps. Companion to kanban research card [b9b163ee](https://ops.heyhenry.io/admin/kanban/research).

## TL;DR

- **Marketing site is the strongest part of the funnel** — branded, on-message, makes specific commercial claims.
- **The signup → dashboard transition is where the seams show.** Two verification gates (email + phone) before product access, generic auth-form copy, and a Supabase-default confirmation email leaking unbranded "powered by Supabase ⚡" footer to real customers (now disabled via `mailer_autoconfirm: true`).
- **Plan tier mismatch** between marketing (Starter / Crew / Growth) and product code (Starter / Growth / Pro / Scale). A customer who sees "Crew $279" on the marketing page won't find that plan in the picker.
- **No welcome email post-activation.** Customer #1 is greeted by silence after they verify.
- **Stripe Checkout branding is not set in code** — relies on Stripe dashboard config. Need to verify it's actually branded.

## The full inventory

| # | Touchpoint | Current state | Gap | Suggested fix | Card needed? |
|---|---|---|---|---|---|
| 1 | **Marketing site landing** (`heyhenry.io`) | Branded hero "The work ends at 5. The business doesn't." Multiple "Start free trial" CTAs → `app.heyhenry.io/signup`. Honest "Soon" labels on roadmap items. Reads as a real product. | None obvious — strongest part of funnel. | n/a | No |
| 2 | **Marketing pricing claims** | 3 plans: Starter $169 / Crew $279 / Growth $399 CAD. Founding offer "Growth $299/mo first 12 months, then $399 locked for life." "14-day free trial — no credit card required." | **Plan names mismatch product code** (which has Starter / Growth / Pro / Scale). "No credit card" claim isn't honored if `/onboarding/plan` requires Stripe Checkout. | Reconcile plan tiers in code with marketing names. Already flagged on dev card [afcd2bfd](https://ops.heyhenry.io/admin/kanban/dev) (Plan picker overhaul). | Existing |
| 3 | **Marketing onboarding claims** | "30-minute setup with help from us. Bring your customers, your jobs, and your rate card — we'll get you running. QuickBooks Online sync." | QBO sync, customer/job import, and CSV upload are all unbuilt — flagged on existing dev cards [874014df](https://ops.heyhenry.io/admin/kanban/dev) (QBO) and [54f17bc9](https://ops.heyhenry.io/admin/kanban/dev) (CSV). Marketing is writing checks the product can't cash. | Either build the imports or soften the marketing copy until they ship. Existing cards cover the build. | Existing |
| 4 | **`/signup` form** | Title "Create your account" / subtitle "Start your first quote in minutes." Fields: business name, email, phone (`+1 604 555 1234` placeholder), password (8+ chars, 1 letter + 1 number). Submit "Create account." Footer "14-day free trial, cancel anytime." | Generic-startup-template copy. No "Welcome to HeyHenry," no contractor-specific framing, no "you're 30 seconds from your first quote" punch. Plan card shown if `?plan=` is set, but the plan card copy ("Selected plan: Growth · monthly · 14-day free trial") is functional, not exciting. | Rewrite signup copy in HeyHenry voice — contractor-first, warmth, payoff framing. Add HeyHenry logo to the page (currently text-only branding). | **New card** |
| 5 | **`signupAction` error paths** | "Invalid signup details." (zod validation), "User already registered." (raw Supabase passthrough), "Could not parse phone number — please enter it with country code." | "User already registered" is a dead-end — no path to recovery (login? password reset? "did you mean to sign in?" link). This is what bit Mike. | Surface "already registered → sign in" inline link. Catch the specific error and route to `/login?email=...` with a friendly message. | **New card** |
| 6 | **Supabase auto-confirmation email** | `From: noreply@mail.app.supabase.io`, `Subject: Confirm Your Signup`, body "Follow this link to confirm your user", footer "powered by Supabase ⚡". Looked like spam. Mike got this. | **Disabled today** via Management API `mailer_autoconfirm: true`. But our `signupAction` still passes `email_confirm: false` to `admin.createUser`, so the user is created unconfirmed and other paths (`signInWithOtp` resend) can still trigger Supabase mailer. | Code change: pass `email_confirm: true` so user is auto-confirmed on creation. Combined with autoconfirm config, kills every Supabase-default email path. Covered by zero-friction card [64ca864d](https://ops.heyhenry.io/admin/kanban/dev). | Existing |
| 7 | **Our Resend confirmation email** (`sendVerificationEmail`) | `From: HeyHenry <noreply@heyhenry.io>` (root domain, not `mail.heyhenry.io` subdomain). `Subject: Confirm your HeyHenry email`. Body "Hi, Confirm your email to finish setting up [Business] on HeyHenry: [Confirm email button]. Or open this link: [...]. This link expires in 24 hours." | Functional but plain — no logo image, no "what's next after you click" framing, no operator-name personalization. Sends a SECOND confirmation email on top of the Supabase one. After zero-friction card ships, this email becomes vestigial. | Delete the call once email_confirm:true ships. Or repurpose as a "welcome to HeyHenry" email that also confirms email implicitly. | Covered by [64ca864d](https://ops.heyhenry.io/admin/kanban/dev) |
| 8 | **Email sender domain** | `noreply@heyhenry.io` (verified in Resend on root domain). | Root-domain sending mixes transactional reputation with anything else heyhenry.io does. Subdomain isolation (`mail.heyhenry.io`) is best practice. SPF/DKIM/DMARC status not verified in this audit. | Already drafted — card [c88f3fb1](https://ops.heyhenry.io/admin/kanban/dev). Move to subdomain + DMARC. | Existing |
| 9 | **`/callback`** | New page (shipped today in PR #127) — handles PKCE server-side, falls back to client component for implicit flow. Visible text: "Signing you in…" or "Signed in. Redirecting…" plain text on white. | No logo, no spinner, no HeyHenry visual identity. Bare technical-looking page during a moment that should feel polished. | Add logo + spinner, brief delay so the user sees a branded splash for ~500ms instead of bare text flash. | **New card (small)** |
| 10 | **`/onboarding/verify`** | Title "Verify your account" / subtitle "Confirm your email and phone to unlock HeyHenry." Two cards: email (with "Resend" + "I clicked the link" buttons) and phone (with OTP send/verify). | The whole page is friction. Customer is forced to wait on email deliverability AND SMS deliverability before they see the product. Killing the gates per [64ca864d](https://ops.heyhenry.io/admin/kanban/dev) deletes the page entirely. | Delete page and supporting server actions when zero-friction card ships. | Covered |
| 11 | **Phone OTP SMS** | `HeyHenry verification code: ${code}. Expires in 10 minutes.` — branded, sender is tenant's Twilio number or country-routed default. | Fine when phone verify is needed. After zero-friction ships, this fires lazily (when user first tries to send SMS), context becomes more important — verify text should explain *why* we're sending: "HeyHenry: confirm your phone to send messages to your customers. Code: 123456." | Only relevant after zero-friction ships. Note in lazy-phone-verify card. | **New card (small)** |
| 12 | **`/onboarding/plan` picker** | Currently collapsed to Growth-only for Mike's launch. Hard-gates email + phone verification. Resolves promo via Stripe API (works as of PR #127). | Picker title "Pick your plan" reads weird with one option. Plan tier shape needs revisit (3 vs 4 tiers). | Existing card [afcd2bfd](https://ops.heyhenry.io/admin/kanban/dev) — Plan picker overhaul. | Existing |
| 13 | **Stripe Checkout** | No `appearance` / `branding` params in checkout session creation ([stripe-subscription.ts:106](src/lib/billing/stripe-subscription.ts:106)). Locale defaults to browser. `automatic_tax: true`, `tax_id_collection: true`. | Branding is whatever Stripe dashboard says. **Audit gap: I haven't verified Stripe dashboard branding settings (logo, primary color, business info, statement descriptor).** Customers see Stripe's framing during the most important payment moment. | Verify Stripe dashboard has HeyHenry logo, colors, business info, support email, statement descriptor `HEYHENRY` (or similar). No code change, dashboard config. | **New card (small)** |
| 14 | **`/onboarding/plan/success`** | Title "Almost there…" Body "Stripe is finishing setting up your subscription. This usually takes a few seconds. Refresh the page in a moment to continue." [Refresh button] | Auto-refresh would be better than asking the user to click a button. The "Refresh" button is a bandage for the lack of webhook polling on the client side. | Replace static page with auto-polling component (poll every 1s for up to 30s, then fall back to "still working — we'll email you" if webhook hasn't fired). | **New card (small)** |
| 15 | **Stripe receipt email** | Sent by Stripe directly. Branding depends on Stripe dashboard config (audit gap, see #13). | Likely default Stripe template if dashboard not configured. | Same fix as #13. | Same card |
| 16 | **Welcome email post-activation** | **Does not exist.** No code path sends a "welcome to HeyHenry" email after a customer subscribes. | The single highest-impact missing email. First impression after they pay. Should feel personal — ideally signed by Jonathan with one specific next step. | Build it. Triggered by Stripe webhook on `checkout.session.completed`. | **New card** |
| 17 | **Dashboard first-login** | Greeting "Good morning, [first name]. Here's your business at a glance." Sections: Attention, Pipeline, Jobs, Metrics. Logo loads if `business_profile.logo_signed_url` is set. | For an empty tenant, every section is empty. Empty states unaudited — likely "no jobs yet" / "no customers yet" with no clear "first action" CTA. | Audit empty states; ensure each section has a contextual "create your first..." CTA when empty. | **New card** |
| 18 | **Twilio business-line provisioning** | Per existing card [2e1bdb7b](https://ops.heyhenry.io/admin/kanban/dev) — not yet built. Customer's phone is collected at signup but no automatic Twilio number is provisioned. | Customer doesn't get a HeyHenry business line on Growth+ today. Manual support ticket required. | Existing card. | Existing |

## Top 5 most embarrassing (priority order)

1. **No welcome email** (#16) — this is the silence after they pay. Single highest-impact missing email.
2. **Plan name mismatch** between marketing and product (#2) — a customer who clicks "Crew $279" on the homepage cannot find that plan after signup. Active broken promise.
3. **Generic signup form copy** (#4) — first impression after the marketing site, and it reads like a YC-template form. No HeyHenry voice, no contractor framing.
4. **Verification gates before product access** (#10) — covered by [64ca864d](https://ops.heyhenry.io/admin/kanban/dev) but deserves first-priority shipping. Single biggest friction reduction.
5. **`/onboarding/plan/success` polling page** (#14) — manual "Refresh" button feels broken when Stripe is slow. Easy fix, immediate UX win.

## New kanban cards to draft (suggested)

Based on this audit, the following NEW cards should be created on the dev board (some are tiny, but worth tracking):

| Title | Size | Priority | Notes |
|---|---|---|---|
| Welcome email post-activation, signed by Jonathan | 3 | 1 | #16. Highest impact gap. |
| `/signup` form copy rewrite — HeyHenry voice + contractor framing | 2 | 2 | #4. Same scope: also add logo to /login, /signup, /callback, /onboarding/verify. |
| "User already registered" → friendly recovery path | 1 | 2 | #5. Inline link to /login with email pre-filled. |
| Stripe dashboard branding audit (logo, colors, statement descriptor) | 1 | 2 | #13, #15. Dashboard config only, no code. |
| `/callback` visual polish — logo + spinner during exchange | 1 | 3 | #9. Tiny, but eliminates a bare-text moment. |
| `/onboarding/plan/success` auto-polling instead of refresh button | 2 | 3 | #14. |
| Dashboard empty-state CTAs ("create your first quote/job/customer") | 3 | 2 | #17. |
| Phone OTP SMS contextual copy (when sent lazily, explain why) | 1 | 3 | #11. Depends on lazy-verify card. |

## Existing cards covering remaining gaps

- [afcd2bfd](https://ops.heyhenry.io/admin/kanban/dev) — Plan picker overhaul (#2, #12)
- [64ca864d](https://ops.heyhenry.io/admin/kanban/dev) — Zero-friction signup, drop verification gates (#6, #7, #10)
- [c88f3fb1](https://ops.heyhenry.io/admin/kanban/dev) — HeyHenry sender domain mail.heyhenry.io with SPF/DKIM (#8)
- [3d7afaba](https://ops.heyhenry.io/admin/kanban/dev) — Operator-invite signup (parallel path for hand-picked customers)
- [59054404](https://ops.heyhenry.io/admin/kanban/dev) — Replace Supabase email templates (mostly moot after zero-friction ships)
- [874014df](https://ops.heyhenry.io/admin/kanban/dev) — QBO import (#3)
- [54f17bc9](https://ops.heyhenry.io/admin/kanban/dev) — CSV upload (#3)
- [2e1bdb7b](https://ops.heyhenry.io/admin/kanban/dev) — Twilio business-line provisioning (#18)

## What's NOT in this audit (deliberate scope cuts)

- Marketing site redesign — separate effort, only inventoried gaps where marketing claims drift from product reality
- Worker (`/w`) and bookkeeper (`/bk`) onboarding paths — different roles, different cards
- Mobile-specific onboarding UX — desktop-only walkthrough
- Localization (English-only audit)
- Accessibility audit (separate concern)
- Resend domain SPF/DKIM/DMARC verification — punted to card [c88f3fb1](https://ops.heyhenry.io/admin/kanban/dev) for actual setup work
