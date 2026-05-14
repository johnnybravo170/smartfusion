/**
 * Polite bounce reply for forwards from unrecognised senders.
 *
 * Sent from `henry@inbound.heyhenry.io` so the conversational voice
 * matches the address the operator forwarded to, AND so any reply lands
 * back at the inbound parser (inbound.heyhenry.io has the MX → Postmark).
 *
 * HTML body lives in `src/lib/email/templates/inbound-bounce.ts`.
 */

import { sendEmail } from '@/lib/email/send';
import { inboundBounceEmailHtml } from '@/lib/email/templates/inbound-bounce';

const HENRY_FROM = 'Henry <henry@inbound.heyhenry.io>';

export async function sendUnknownSenderBounce(args: {
  to: string;
  originalSubject: string;
}): Promise<void> {
  const subject = args.originalSubject.toLowerCase().startsWith('re:')
    ? args.originalSubject
    : `Re: ${args.originalSubject || '(no subject)'}`;

  const html = inboundBounceEmailHtml({
    originalSubject: args.originalSubject || '(no subject)',
    fromAddress: args.to,
  });

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
