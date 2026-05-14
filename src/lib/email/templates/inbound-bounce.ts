/**
 * Bounce reply sent when a forward arrives at henry@inbound.heyhenry.io
 * from a sender we can't match to a tenant (owner/admin) or a customer
 * on any active project.
 *
 * No tenant logo — this email goes TO an outside sender from HeyHenry
 * itself, so rendering some random tenant's logo would be confusing.
 *
 * Proof-of-shape migration to renderEmailShell. The callout lives mid-body
 * (between the intro paragraph and the "What to do" subhead), so it's
 * composed inline via renderCalloutHtml instead of using the shell's
 * top-level callout slot.
 */

import { renderCalloutHtml, renderEmailShell } from '@/lib/email/layout';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function inboundBounceEmailHtml({
  originalSubject,
  fromAddress,
}: {
  originalSubject: string;
  fromAddress: string;
}): string {
  const safeSubject = escapeHtml(originalSubject || '(no subject)');
  const safeFrom = escapeHtml(fromAddress);

  const subjectCallout = renderCalloutHtml({
    variant: 'note',
    label: 'Subject of your forward',
    contentHtml: safeSubject,
  });

  const body = `<p style="margin: 0 0 16px;">Thanks for forwarding something to Henry — but I don't have <strong>${safeFrom}</strong> on file as a HeyHenry account email, so I haven't filed it.</p>
${subjectCallout}
<h3 style="color: #0a0a0a; margin: 24px 0 8px; font-size: 16px;">What to do</h3>
<p style="margin: 0 0 12px;">Forward again from the email address you signed up to HeyHenry with — that's the only address I currently accept attachments from.</p>
<p style="margin: 0 0 12px;">If you want a second address allowlisted, that's coming soon. Reply to <a href="mailto:support@heyhenry.io" style="color: #0a0a0a; font-weight: 500;">support@heyhenry.io</a> and we'll sort it.</p>`;

  return renderEmailShell({
    heading: "I didn't recognise this sender",
    body,
    signoff: '— Henry',
    footerKey: 'inbound_bounce',
  });
}
