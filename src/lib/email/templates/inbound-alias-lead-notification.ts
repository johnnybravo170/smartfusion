/**
 * Operator-facing notification: a homeowner emailed one of the
 * tenant's registered inbound aliases (e.g. `hello@<tenant-domain>`).
 *
 * Sibling of `widget-lead-notification.ts` — same surface goal ("new
 * lead via your website") but framed for email-sourced leads where the
 * phone is unknown, the "description" is the email body, and the
 * customer email is reliable (it's the From address).
 *
 * No tenant logo (goes TO the operator). CTA jumps to /inbox/intake/<id>
 * so they can triage with one click.
 */

import { escapeHtml, safeMailtoHref, safeUrl } from '@/lib/email/escape';
import { renderEmailShell } from '@/lib/email/layout';

export type InboundAliasLeadNotificationInput = {
  businessName: string;
  /** The alias the homeowner emailed (e.g. "hello@connectcontracting.ca"). */
  receivedAt: string;
  /** Display name from the From header, or the bare address if no name. */
  fromDisplay: string;
  /** Bare email address from the From header. */
  fromAddress: string;
  /** Original email subject. */
  subject: string;
  /** Plain-text body. Will be escaped and newline-preserved. */
  bodyText: string;
  /** Number of attachments (photos, PDFs). Shown as a count, not inlined. */
  attachmentCount: number;
  /** Deep link into /inbox/intake/<id> for one-click triage. */
  intakeUrl: string;
};

const BODY_PREVIEW_CAP = 2000;

export function inboundAliasLeadNotificationHtml(input: InboundAliasLeadNotificationInput): string {
  const safeBusiness = escapeHtml(input.businessName);
  const safeFromDisplay = escapeHtml(input.fromDisplay);
  const safeFromAddress = escapeHtml(input.fromAddress);
  const safeSubject = escapeHtml(input.subject);
  const safeReceivedAt = escapeHtml(input.receivedAt);
  const mailtoHref = safeMailtoHref(input.fromAddress);
  const fromCell = mailtoHref ? `<a href="${mailtoHref}">${safeFromAddress}</a>` : safeFromAddress;

  const trimmedBody = input.bodyText.trim().slice(0, BODY_PREVIEW_CAP);
  const truncated = input.bodyText.length > BODY_PREVIEW_CAP;
  const safeBody = escapeHtml(trimmedBody).replace(/\n/g, '<br />');
  const truncatedNote = truncated
    ? `<p style="color: #999; font-size: 12px; margin: 8px 0 0;">Message truncated — full text in Henry.</p>`
    : '';

  const attachmentLine =
    input.attachmentCount > 0
      ? `<p style="color: #555; margin: 16px 0 0; font-size: 14px;">${input.attachmentCount} attachment${
          input.attachmentCount === 1 ? '' : 's'
        } received — view in Henry to see them.</p>`
      : '';

  const body = `<p>Hi ${safeBusiness},</p>
<p>A new lead came in to <strong>${safeReceivedAt}</strong>:</p>
<table style="width: 100%; border-collapse: collapse; margin: 16px 0 8px;">
  <tr>
    <td style="padding: 6px 0; color: #666; width: 100px;">From</td>
    <td style="padding: 6px 0; font-weight: 500;">${safeFromDisplay}</td>
  </tr>
  <tr>
    <td style="padding: 6px 0; color: #666;">Reply to</td>
    <td style="padding: 6px 0;">${fromCell}</td>
  </tr>
  <tr>
    <td style="padding: 6px 0; color: #666;">Subject</td>
    <td style="padding: 6px 0;">${safeSubject}</td>
  </tr>
</table>
<div style="background: #f7f7f5; border-left: 3px solid #cfcfc6; padding: 12px 16px; margin: 8px 0; border-radius: 4px;">
  <div style="color: #666; font-size: 13px; margin-bottom: 4px;">What they wrote</div>
  <div style="color: #1a1a1a;">${safeBody}</div>
  ${truncatedNote}
</div>
${attachmentLine}`;

  return renderEmailShell({
    heading: 'New lead via your website',
    body,
    cta: { label: 'Open in Henry', href: safeUrl(input.intakeUrl) },
    footerKey: 'inbound_alias_lead_notification',
  });
}
