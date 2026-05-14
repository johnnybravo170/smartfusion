---
name: email-templates
description: Authoring transactional email HTML in HeyHenry — always go through renderEmailShell, register an EmailTemplateKey, follow email-safe CSS rules, pick the right CASL category, and verify in Postmark Email Tests across Gmail / Outlook / Apple Mail (incl. dark mode) before shipping. Triggers on: new email template, edit email template, sales/transactional email, Postmark, Resend, brandingFooterHtml, CASL category.
---

# Authoring HeyHenry transactional emails

Sister doc: [docs/email-architecture.md](../../../docs/email-architecture.md) covers send infrastructure (four sender classes, stream routing, DNS). This skill covers the visual + content layer that sits on top.

Human-readable mirror: [docs/email-templates.md](../../../docs/email-templates.md).

## The one rule

**Every new transactional email goes through `renderEmailShell` from [src/lib/email/layout.ts](../../../src/lib/email/layout.ts).** No more hand-rolling `<!DOCTYPE>` + body styles + footer assembly in every template. The shell owns: doctype, font stack, max-width, padding, line-height, color tokens, callout / CTA / signoff styling, divider, footer.

Shape:

```ts
import { renderEmailShell } from '@/lib/email/layout';
import { brandingLogoHtml } from '@/lib/email/branding';

export function myEmailHtml(args: { ... }): string {
  return renderEmailShell({
    heading: 'Your project portal',
    body: `<p>Hi ${firstName},</p>
<p>...</p>`,
    callout: { variant: 'quote', contentHtml: escapeHtml(args.note) },
    cta: { label: 'View Project', href: args.url },
    signoff: '— Henry',
    brandingLogoHtml: brandingLogoHtml(args.logoUrl, args.businessName),
    footerKey: 'my_template_key',
  });
}
```

Render order is fixed: logo → heading → body → callout → cta → signoff → hr → footer. If you need a callout mid-body (between two paragraphs that both sit above the CTA), import `renderCalloutHtml` and inline it inside `body` — don't try to interleave by changing the shell. See [src/lib/email/templates/inbound-bounce.ts](../../../src/lib/email/templates/inbound-bounce.ts) for that pattern.

### Variants

- **Callout** — `'note'` (default, gray bg, accent border), `'quote'` (gray bg, pre-wrap so operator line breaks survive), `'warning'` (amber bg + border).
- **CTA** — `'primary'` (filled black, default), `'secondary'` (outline). One CTA per email; secondary is for "maybe later" / "view alternative" affordances rare in our set.

## Always register an EmailTemplateKey

Open [src/lib/email/branding.ts](../../../src/lib/email/branding.ts) and add your key to the `EmailTemplateKey` union:

```ts
export type EmailTemplateKey =
  | 'change_order'
  | ...
  | 'my_template_key';  // ← new entry
```

The key drives the `utm_content=` parameter on the "Sent via HeyHenry" footer link — so each surface's referral traffic is attributable in analytics. The same key gets passed as `footerKey` to `renderEmailShell`.

## Email-safe CSS rules

Inbox renderers (Gmail, Outlook desktop, Apple Mail, mobile webviews) are a decade behind modern browsers. Stick to:

- **Inline styles only.** No `<style>` blocks, no class names. Outlook strips `<style>` in some configs and Gmail-on-mobile rewrites class selectors.
- **No flexbox, no grid.** For columns, use a `<table>` with inline `width=` attrs and `style="border-collapse: collapse;"`. See [lead-notification.ts](../../../src/lib/email/templates/lead-notification.ts) for the canonical two-column shape.
- **No web fonts.** Use the system stack already baked into the shell (`system-ui, -apple-system, BlinkMacSystemFont, sans-serif`). Custom fonts get stripped or downloaded inconsistently.
- **No `background-image`.** Outlook ignores them. Use solid colors.
- **No JavaScript.** Stripped everywhere. CTAs are `<a href>` styled to look like buttons.
- **Pixel widths over %.** Outlook treats `%` widths unpredictably inside tables.
- **Always supply both HTML and a plain-text alternative.** `sendEmail` in [src/lib/email/send.ts](../../../src/lib/email/send.ts) auto-derives text from HTML — only override `text` if the auto-version is wrong.

## Subject lines

- **Replies / threads** — prefix with `Re: ` if the original subject doesn't already start with it. See [src/lib/inbound-email/bounce.ts](../../../src/lib/inbound-email/bounce.ts):

  ```ts
  const subject = original.toLowerCase().startsWith('re:') ? original : `Re: ${original}`;
  ```

- **Transactional first sends** — descriptive, short. `${businessName} — Estimate for ${projectName}` not `An estimate has been prepared for your project at ...`.
- **Marketing** — short and curiosity-driven. The AR engine in `src/lib/ar/` handles broadcasts; don't hand-roll one-offs from a template file.

## Picking a CASL category

Every `sendEmail` call requires a `caslCategory`. Canonical taxonomy lives in the docblock of [src/lib/email/send.ts](../../../src/lib/email/send.ts) — read it before guessing.

Flowchart:

```
Is this a direct reply to a message the recipient sent us first?
  └─ YES → 'response_to_request'
  └─ NO ↓

Is this purely operational — receipt, invoice, password reset, appointment confirmation, completion notice, auth flow?
  └─ YES → 'transactional'
  └─ NO ↓

Is this promotional / marketing content with calls to action?
  └─ Promotional + sent ≤ 6 months since a customer inquiry      → 'implied_consent_inquiry'
  └─ Promotional + sent ≤ 2 years since a paid job (existing biz) → 'implied_consent_ebr'
  └─ Promotional + recipient opted in to a list                  → 'express_consent'

(CEM categories MUST go through the AR engine in src/lib/ar/ — they require
 RFC 8058 unsubscribe headers, suppression checks, and engagement webhooks
 that sendEmail does not bolt on for direct callers.)
```

If you reach for `'unclassified'`, don't — it's a legacy escape hatch slated for removal. Pick from the list above or stop and ask.

## Verify before shipping

Don't merge a template change without inbox-rendering it.

1. Send a real test through Postmark — either via a one-off `pnpm tsx` script, the dev server, or by triggering the flow in staging.
2. In Postmark dashboard → **Email tests** → preview the rendering across:
   - **Gmail** (web + Android + iOS) — most forgiving but strips a lot
   - **Outlook desktop** — strictest; if it looks right here it looks right everywhere
   - **Apple Mail** — light AND dark mode (dark mode inverts some colors and Apple's auto-color-shift can mangle low-contrast text)
3. Click every link in the rendered preview — confirm UTMs land where expected.
4. Send to your own inbox and view raw source (`View original` in Gmail) — confirm `SPF: PASS`, `DKIM: PASS`.

## Migration status (as of 2026-05-13)

- **Migrated to `renderEmailShell`:** `inbound-bounce.ts`, `portal-invite.ts`.
- **Awaiting migration on next touch:** 14 remaining templates carry a `// TODO(email-shell): migrate to renderEmailShell on next touch` marker. When you next touch any of them for a feature/bug fix, do the migration as part of the same change — but don't do big-bang migrations as standalone PRs.

## Anti-patterns

- ❌ Copy-pasting another template's body wrapper and hand-tweaking. Goes through the shell instead.
- ❌ Adding a dependency (React Email, MJML, Handlebars). String templates are fine at our scale; new dependencies need a strong argument.
- ❌ Sending `text: undefined` because "the HTML is enough". Spam filters down-weight HTML-only emails; let `sendEmail` auto-derive a text alternative.
- ❌ Embedding a `<style>` block. Inline-only, see above.
- ❌ Hardcoding `noreply@heyhenry.io` as the `from`. Either let `sendEmail` pick per-stream defaults, or pass `tenantId` and let `getTenantFromHeader()` build it.
