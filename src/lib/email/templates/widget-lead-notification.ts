/**
 * Operator-facing notification: a homeowner just submitted the smart-form
 * widget on the contractor's website.
 *
 * No tenant logo (this goes TO the operator). CTA jumps them straight to
 * the intake draft in /inbox/intake so they can triage with one click.
 *
 * Photo thumbnails are deliberately omitted from the email body — the
 * CTA is the photo viewer. Inline image rendering across email clients
 * (Outlook Win 16, Apple Mail dark mode, Gmail proxy) is unreliable
 * enough that we'd rather show a count + a button than a broken grid.
 */

import { escapeHtml, safeMailtoHref, safeTelHref, safeUrl } from '@/lib/email/escape';
import { renderEmailShell } from '@/lib/email/layout';

export type WidgetLeadNotificationInput = {
  businessName: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  description: string;
  photoCount: number;
  intakeUrl: string;
};

export function widgetLeadNotificationHtml(input: WidgetLeadNotificationInput): string {
  const safeBusiness = escapeHtml(input.businessName);
  const safeName = escapeHtml(input.customerName);
  const safePhone = escapeHtml(input.customerPhone);
  const telHref = safeTelHref(input.customerPhone);
  const phoneCell = telHref ? `<a href="${telHref}">${safePhone}</a>` : safePhone;

  let emailRow = '';
  if (input.customerEmail) {
    const safeEmail = escapeHtml(input.customerEmail);
    const mailtoHref = safeMailtoHref(input.customerEmail);
    const emailCell = mailtoHref ? `<a href="${mailtoHref}">${safeEmail}</a>` : safeEmail;
    emailRow = `
    <tr>
      <td style="padding: 6px 0; color: #666; vertical-align: top;">Email</td>
      <td style="padding: 6px 0;">${emailCell}</td>
    </tr>`;
  }

  const photoLine =
    input.photoCount > 0
      ? `<p style="color: #555; margin: 16px 0 0; font-size: 14px;">${input.photoCount} photo${
          input.photoCount === 1 ? '' : 's'
        } attached — view in Henry to see them.</p>`
      : '';

  const safeDescription = escapeHtml(input.description).replace(/\n/g, '<br />');

  const body = `<p>Hi ${safeBusiness},</p>
<p>A new lead came in through your website:</p>
<table style="width: 100%; border-collapse: collapse; margin: 16px 0 8px;">
  <tr>
    <td style="padding: 6px 0; color: #666; width: 100px;">Name</td>
    <td style="padding: 6px 0; font-weight: 500;">${safeName}</td>
  </tr>
  <tr>
    <td style="padding: 6px 0; color: #666;">Phone</td>
    <td style="padding: 6px 0;">${phoneCell}</td>
  </tr>${emailRow}
</table>
<div style="background: #f7f7f5; border-left: 3px solid #cfcfc6; padding: 12px 16px; margin: 8px 0; border-radius: 4px;">
  <div style="color: #666; font-size: 13px; margin-bottom: 4px;">What they wrote</div>
  <div style="white-space: pre-wrap; color: #1a1a1a;">${safeDescription}</div>
</div>
${photoLine}`;

  return renderEmailShell({
    heading: 'New lead from your website',
    body,
    cta: { label: 'Open in Henry', href: safeUrl(input.intakeUrl) },
    footerKey: 'widget_lead_notification',
  });
}
