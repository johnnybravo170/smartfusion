/**
 * Portal invite — sent when an operator turns on a customer-facing project
 * portal.
 *
 * Proof-of-shape migration to renderEmailShell. The operator's optional
 * note becomes the shell's top-level callout (variant 'quote' so any line
 * breaks they typed survive). The "Bookmark this link" hint moves into the
 * body before the CTA — same information, slight reorder.
 */

import { brandingLogoHtml } from '@/lib/email/branding';
import { type EmailShellCallout, renderEmailShell } from '@/lib/email/layout';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function portalInviteEmailHtml({
  businessName,
  logoUrl,
  projectName,
  customerName,
  portalUrl,
  note,
}: {
  businessName: string;
  logoUrl?: string | null;
  projectName: string;
  customerName: string;
  portalUrl: string;
  /** Optional operator note — rendered as a quoted callout above the CTA. */
  note?: string | null;
}): string {
  const firstName = customerName.split(' ')[0];

  const callout: EmailShellCallout | undefined = note?.trim()
    ? { variant: 'quote', contentHtml: escapeHtml(note) }
    : undefined;

  const body = `<p>Hi ${firstName},</p>
<p>${businessName} has set up a project portal for <strong>${projectName}</strong>. You can track your project's progress at any time.</p>
<p style="font-size: 14px; color: #666;">Bookmark this link to check back anytime. No login required.</p>`;

  return renderEmailShell({
    heading: 'Your Project Portal',
    body,
    callout,
    cta: { label: 'View Your Project', href: portalUrl },
    brandingLogoHtml: brandingLogoHtml(logoUrl, businessName),
    footerKey: 'portal_invite',
  });
}
