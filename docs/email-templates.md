# HeyHenry Email Templates

Visual + content layer for outbound transactional emails. The sibling doc [docs/email-architecture.md](./email-architecture.md) covers send infrastructure (four sender classes, stream routing, DNS). This doc covers everything above the wire: the HTML shell, callout/CTA variants, subject-line conventions, CASL category picking, and pre-ship verification.

**Last updated:** 2026-05-13
**Authoring assistant:** the same content is encoded in [.claude/skills/email-templates/SKILL.md](../.claude/skills/email-templates/SKILL.md) so it surfaces automatically when you ask Claude to write or modify an email template.

## The shell

Every new transactional email goes through `renderEmailShell` from [src/lib/email/layout.ts](../src/lib/email/layout.ts). The shell owns:

- DOCTYPE + `<html>` + `<body>` scaffolding
- Font stack: `system-ui, -apple-system, BlinkMacSystemFont, sans-serif`
- `max-width: 600px`, `padding: 24px`, `line-height: 1.5`
- Color tokens: heading `#0a0a0a`, body `#1a1a1a`, muted `#666`, accent `#0a0a0a`, callout bg `#f8fafc`
- Callout block (note / quote / warning variants)
- CTA button (primary filled / secondary outline)
- Sign-off paragraph
- HR divider
- "Sent via HeyHenry" footer (with per-template UTM)

Render order is fixed: logo → heading → body → callout → cta → signoff → hr → footer.

If you need a callout *inside* the body (e.g. between two paragraphs that both sit above the CTA), import `renderCalloutHtml` from the same module and inline it inside your `body` HTML — don't try to interleave by changing the shell. See [src/lib/email/templates/inbound-bounce.ts](../src/lib/email/templates/inbound-bounce.ts) for that pattern.

### Example

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

### Variants

| Slot    | Variant        | When to use                                                                |
| ------- | -------------- | -------------------------------------------------------------------------- |
| Callout | `'note'`       | Default. Informational. Gray bg, accent border.                            |
| Callout | `'quote'`      | Operator-authored text where line breaks matter. Same bg, `white-space: pre-wrap`. |
| Callout | `'warning'`    | Amber bg + border. Reserve for failure / overdue / blocked states.         |
| CTA     | `'primary'`    | Default. Filled black button. One per email.                               |
| CTA     | `'secondary'`  | Outlined. Rare — only when you need a non-dominant link alongside primary. |

## Register an EmailTemplateKey

Add the new key to the `EmailTemplateKey` union in [src/lib/email/branding.ts](../src/lib/email/branding.ts). The key drives the `utm_content=` parameter on the "Sent via HeyHenry" footer link, so each surface's referral traffic is attributable in analytics. Pass the same string as `footerKey` to `renderEmailShell`.

## Email-safe CSS rules

Inbox renderers (Gmail, Outlook desktop, Apple Mail, mobile webviews) are a decade behind modern browsers. The shell's defaults already comply; if you compose your own `body` HTML, stick to:

- **Inline styles only.** No `<style>` blocks, no class names. Outlook strips `<style>` in some configs and Gmail-on-mobile rewrites class selectors.
- **No flexbox, no grid.** Use a `<table>` with inline `width=` attrs and `style="border-collapse: collapse;"`. See [lead-notification.ts](../src/lib/email/templates/lead-notification.ts) for the canonical two-column shape.
- **No web fonts.** Use the system stack baked into the shell. Custom fonts get stripped or downloaded inconsistently.
- **No `background-image`.** Outlook ignores them. Use solid colors.
- **No JavaScript.** Stripped everywhere. CTAs are `<a href>` styled to look like buttons.
- **Pixel widths over %.** Outlook treats `%` widths unpredictably inside tables.
- **Always supply both HTML and plain text.** `sendEmail` auto-derives text from HTML — only override `text` if the auto-version is wrong.

## Subject lines

- **Replies / threads** — prefix with `Re: ` if the original subject doesn't already start with it. Pattern:

  ```ts
  const subject = original.toLowerCase().startsWith('re:') ? original : `Re: ${original}`;
  ```

- **Transactional first sends** — descriptive, short. `${businessName} — Estimate for ${projectName}` not `An estimate has been prepared for your project at ...`.
- **Marketing** — short and curiosity-driven. The AR engine in `src/lib/ar/` handles broadcasts; don't hand-roll one-offs from a template file.

## Picking a CASL category

Every `sendEmail` call requires a `caslCategory`. Canonical taxonomy lives in the docblock of [src/lib/email/send.ts](../src/lib/email/send.ts). Decision flow:

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

If you reach for `'unclassified'`, don't — it's a legacy escape hatch slated for removal.

## Verify before shipping

Never merge a template change without inbox-rendering it.

1. Send a real test through Postmark — either via a one-off `pnpm tsx` script, the dev server, or by triggering the flow in staging.
2. In Postmark dashboard → **Email tests** → preview the rendering across:
   - **Gmail** (web + Android + iOS) — most forgiving but strips a lot
   - **Outlook desktop** — strictest; if it looks right here it looks right everywhere
   - **Apple Mail** — light AND dark mode (dark mode inverts some colors and Apple's auto-color-shift can mangle low-contrast text)
3. Click every link in the rendered preview — confirm UTMs land where expected.
4. Send to your own inbox and view raw source (`View original` in Gmail) — confirm `SPF: PASS`, `DKIM: PASS`.

## Migration status (2026-05-13)

| Template                                    | Status                                  |
| ------------------------------------------- | --------------------------------------- |
| `inbound-bounce.ts`                         | ✅ Migrated (proof-of-shape)            |
| `portal-invite.ts`                          | ✅ Migrated (proof-of-shape)            |
| `change-order-approval.ts`                  | ⏳ TODO(email-shell) — migrate on next touch |
| `estimate-accepted-notification.ts`         | ⏳ TODO(email-shell)                    |
| `estimate-approval.ts`                      | ⏳ TODO(email-shell)                    |
| `estimate-feedback-notification.ts`         | ⏳ TODO(email-shell)                    |
| `estimate-viewed-notification.ts`           | ⏳ TODO(email-shell)                    |
| `invoice-email.ts`                          | ⏳ TODO(email-shell)                    |
| `job-booking.ts`                            | ⏳ TODO(email-shell)                    |
| `lead-notification.ts`                      | ⏳ TODO(email-shell)                    |
| `project-message-operator-notification.ts`  | ⏳ TODO(email-shell)                    |
| `pulse-update.ts`                           | ⏳ TODO(email-shell)                    |
| `quote-email.ts`                            | ⏳ TODO(email-shell)                    |
| `quote-response.ts`                         | ⏳ TODO(email-shell)                    |
| `referral-invite.ts`                        | ⏳ TODO(email-shell)                    |
| `refund-confirmation.ts`                    | ⏳ TODO(email-shell)                    |

Strategy is incremental: migrate as part of the next feature/bug change to each file, not as a big-bang refactor PR.

## Anti-patterns

- ❌ Copy-pasting another template's body wrapper and hand-tweaking. Use the shell instead.
- ❌ Adding a dependency (React Email, MJML, Handlebars). String templates are fine at our scale; new dependencies need a strong argument.
- ❌ Sending `text: undefined` because "the HTML is enough". Spam filters down-weight HTML-only emails; let `sendEmail` auto-derive a text alternative.
- ❌ Embedding a `<style>` block. Inline-only.
- ❌ Hardcoding `noreply@heyhenry.io` as the `from`. Either let `sendEmail` pick per-stream defaults, or pass `tenantId` and let `getTenantFromHeader()` build it.
