/**
 * Single source of truth for transactional email visual structure.
 *
 * Render order (top → bottom):
 *   doctype → tenant logo (optional) → heading → body → callout (optional) →
 *   cta (optional) → signoff (optional) → divider → footer.
 *
 * Callers who need a callout *inside* their body composition (e.g. between two
 * paragraphs that should both sit above the CTA) import `renderCalloutHtml`
 * and inline it themselves rather than using the top-level slot.
 *
 * Input contract:
 *   - `heading`, `signoff`, `callout.label`, `cta.label`  → plain text, escaped
 *      here.
 *   - `body`, `callout.contentHtml`                       → HTML, caller
 *      escapes untrusted input at the boundary.
 *   - `cta.href`                                          → URL, attribute-
 *      escaped here.
 *
 * Tokens (color, font, max-width, padding) live as module-local constants so
 * adjusting the look of every transactional email is a one-file change. See
 * docs/email-templates.md for the rationale and the do/don't of email-safe
 * CSS.
 */

import { brandingFooterHtml, type EmailTemplateKey } from '@/lib/email/branding';
import { escapeHtml } from '@/lib/email/escape';

export type CalloutVariant = 'note' | 'quote' | 'warning';
export type CtaVariant = 'primary' | 'secondary';

export type EmailShellCallout = {
  /** Visual treatment. Defaults to 'note'. */
  variant?: CalloutVariant;
  /** Small label rendered above the content (e.g. "Subject of your forward"). */
  label?: string;
  /** HTML for the callout body. Caller is responsible for escaping. */
  contentHtml: string;
};

export type EmailShellCta = {
  /** 'primary' (filled accent) or 'secondary' (outline). Defaults to 'primary'. */
  variant?: CtaVariant;
  label: string;
  href: string;
};

export type RenderEmailShellInput = {
  heading: string;
  body: string;
  callout?: EmailShellCallout;
  cta?: EmailShellCta;
  signoff?: string;
  /** Pre-rendered logo HTML from `brandingLogoHtml(...)`. Omit for emails not
   *  branded to a tenant (system / platform / inbound bounces). */
  brandingLogoHtml?: string;
  /** Footer key — drives the per-template UTM in `brandingFooterHtml`. */
  footerKey: EmailTemplateKey;
};

const FONT_STACK = 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
const MAX_WIDTH_PX = 600;
const BODY_PADDING_PX = 24;
const LINE_HEIGHT = 1.5;
const COLOR_HEADING = '#0a0a0a';
const COLOR_BODY = '#1a1a1a';
const COLOR_MUTED = '#666';
const COLOR_ACCENT = '#0a0a0a';
const COLOR_CALLOUT_BG = '#f8fafc';
const COLOR_CALLOUT_BG_WARNING = '#fff7ed';
const COLOR_CALLOUT_BORDER_WARNING = '#f59e0b';
const COLOR_SIGNOFF = '#444';
const CTA_RADIUS_PX = 6;
const CTA_PADDING = '12px 24px';
const HR_HTML = '<hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />';

export function renderCalloutHtml(callout: EmailShellCallout): string {
  const variant = callout.variant ?? 'note';
  const isWarning = variant === 'warning';
  const borderColor = isWarning ? COLOR_CALLOUT_BORDER_WARNING : COLOR_ACCENT;
  const bgColor = isWarning ? COLOR_CALLOUT_BG_WARNING : COLOR_CALLOUT_BG;
  const usePreWrap = variant === 'quote';

  const labelHtml = callout.label
    ? `<p style="margin: 0; font-size: 13px; color: ${COLOR_MUTED};">${escapeHtml(callout.label)}</p>`
    : '';
  const contentStyle = callout.label
    ? 'margin: 4px 0 0; font-size: 14px; color: #222; font-weight: 500;'
    : `margin: 0; font-size: 14px; color: #222;${usePreWrap ? ' white-space: pre-wrap; line-height: 1.5;' : ''}`;

  return `<div style="margin: 20px 0; padding: 12px 16px; border-left: 3px solid ${borderColor}; background: ${bgColor}; border-radius: 4px;">
    ${labelHtml}<p style="${contentStyle}">${callout.contentHtml}</p>
  </div>`;
}

export function renderCtaHtml(cta: EmailShellCta): string {
  const variant = cta.variant ?? 'primary';
  const isPrimary = variant === 'primary';
  const style = isPrimary
    ? `display: inline-block; padding: ${CTA_PADDING}; background: ${COLOR_ACCENT}; color: white; text-decoration: none; border-radius: ${CTA_RADIUS_PX}px; font-weight: 500;`
    : `display: inline-block; padding: ${CTA_PADDING}; background: white; color: ${COLOR_ACCENT}; text-decoration: none; border: 1px solid ${COLOR_ACCENT}; border-radius: ${CTA_RADIUS_PX}px; font-weight: 500;`;
  return `<p><a href="${escapeHtml(cta.href)}" style="${style}">${escapeHtml(cta.label)}</a></p>`;
}

export function renderEmailShell({
  heading,
  body,
  callout,
  cta,
  signoff,
  brandingLogoHtml,
  footerKey,
}: RenderEmailShellInput): string {
  const bodyStyle = `font-family: ${FONT_STACK}; max-width: ${MAX_WIDTH_PX}px; margin: 0 auto; padding: ${BODY_PADDING_PX}px; color: ${COLOR_BODY}; line-height: ${LINE_HEIGHT};`;

  const sections: string[] = [];
  if (brandingLogoHtml) sections.push(brandingLogoHtml);
  sections.push(
    `<h2 style="color: ${COLOR_HEADING}; margin: 0 0 16px; font-size: 20px;">${escapeHtml(heading)}</h2>`,
  );
  sections.push(body);
  if (callout) sections.push(renderCalloutHtml(callout));
  if (cta) sections.push(renderCtaHtml(cta));
  if (signoff)
    sections.push(
      `<p style="margin: 24px 0 0; color: ${COLOR_SIGNOFF};">${escapeHtml(signoff)}</p>`,
    );
  sections.push(HR_HTML);
  sections.push(brandingFooterHtml(footerKey));

  return `<!DOCTYPE html>
<html>
<body style="${bodyStyle}">
${sections.join('\n')}
</body>
</html>`;
}
