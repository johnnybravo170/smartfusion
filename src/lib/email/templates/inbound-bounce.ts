/**
 * Bounce reply sent when a forward arrives at henry@inbound.heyhenry.io
 * from a sender we can't match to a tenant (owner/admin) or a customer
 * on any active project.
 *
 * No tenant logo — this email goes TO an outside sender from HeyHenry
 * itself, so rendering some random tenant's logo would be confusing.
 */

import { brandingFooterHtml } from '@/lib/email/branding';

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

  return `<!DOCTYPE html>
<html>
<body style="font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.5;">
  <h2 style="color: #0a0a0a; margin: 0 0 16px; font-size: 20px;">I didn't recognise this sender</h2>

  <p style="margin: 0 0 16px;">Thanks for forwarding something to Henry — but I don't have <strong>${safeFrom}</strong> on file as a HeyHenry account email, so I haven't filed it.</p>

  <div style="margin: 20px 0; padding: 12px 16px; border-left: 3px solid #0a0a0a; background: #f8fafc; border-radius: 4px;">
    <p style="margin: 0; font-size: 13px; color: #666;">Subject of your forward</p>
    <p style="margin: 4px 0 0; font-size: 14px; color: #222; font-weight: 500;">${safeSubject}</p>
  </div>

  <h3 style="color: #0a0a0a; margin: 24px 0 8px; font-size: 16px;">What to do</h3>
  <p style="margin: 0 0 12px;">Forward again from the email address you signed up to HeyHenry with — that's the only address I currently accept attachments from.</p>
  <p style="margin: 0 0 12px;">If you want a second address allowlisted, that's coming soon. Reply to <a href="mailto:support@heyhenry.io" style="color: #0a0a0a; font-weight: 500;">support@heyhenry.io</a> and we'll sort it.</p>

  <p style="margin: 24px 0 0; color: #444;">— Henry</p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  ${brandingFooterHtml('inbound_bounce')}
</body>
</html>`;
}
