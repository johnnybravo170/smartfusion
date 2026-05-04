/**
 * Polite bounce reply for forwards from unrecognised senders.
 *
 * Sent from `henry@heyhenry.io` so the conversational voice matches the
 * inbox the operator forwarded to. Until A0 verifies that address in
 * Resend it will fail-soft (logged in email_send_log as `failed`); we
 * still persist the bounced inbound_emails row regardless.
 */

import { sendEmail } from '@/lib/email/send';

const HENRY_FROM = 'Henry <henry@heyhenry.io>';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function sendUnknownSenderBounce(args: {
  to: string;
  originalSubject: string;
}): Promise<void> {
  const subject = args.originalSubject.toLowerCase().startsWith('re:')
    ? args.originalSubject
    : `Re: ${args.originalSubject || '(no subject)'}`;

  const safeSubject = escapeHtml(args.originalSubject || '(no subject)');

  const html = `
    <p>Hi,</p>
    <p>I didn't recognise this sender address, so I haven't filed your forward
    (subject: <em>${safeSubject}</em>).</p>
    <p>Forward from the email address you signed up to HeyHenry with — that's
    the only address I currently accept attachments from.</p>
    <p>If you want a second address allowlisted, that's coming soon. Reply to
    <a href="mailto:support@heyhenry.io">support@heyhenry.io</a> and we'll sort
    it.</p>
    <p>— Henry</p>
  `.trim();

  const result = await sendEmail({
    to: args.to,
    subject,
    html,
    from: HENRY_FROM,
    caslCategory: 'response_to_request',
    relatedType: 'other',
  });

  if (!result.ok) {
    console.warn('[inbound-email/bounce] send failed', {
      to: args.to,
      error: result.error,
    });
  }
}
