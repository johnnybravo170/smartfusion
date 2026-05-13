import { brandingFooterHtml } from '@/lib/email/branding';
import { escapeHtml } from '@/lib/email/escape';

/**
 * Sent after a self-serve cancel + prorated refund. Tone: warm, no friction,
 * no "we'll miss you" theatre. Just facts: amount, card, when access ends.
 */
export function refundConfirmationEmailHtml({
  firstName,
  refundAmountFormatted,
  cardLast4,
  accessEndsAtFormatted,
  isTrial,
}: {
  firstName: string;
  refundAmountFormatted: string; // e.g. "$83.42"
  cardLast4: string | null;
  accessEndsAtFormatted: string; // e.g. "Mon, May 12, 2026"
  isTrial: boolean;
}): string {
  const greeting = `Hi ${escapeHtml(firstName)},`;

  const body = isTrial
    ? `<p>We've cancelled your trial. No charge was made, so there's nothing to refund.</p>
       <p>Your access ended just now. If you change your mind, your data is preserved for 30 days — just sign back in and pick a plan.</p>`
    : `<p>We've processed your cancellation and refunded <strong>${escapeHtml(refundAmountFormatted)}</strong>${
        cardLast4
          ? ` to the card ending in •••• ${escapeHtml(cardLast4)}`
          : ' to your original payment method'
      }. Most banks post the refund within 5-10 business days.</p>
       <p>Your account stays active until <strong>${escapeHtml(accessEndsAtFormatted)}</strong> — feel free to export anything you need.</p>
       <p>No bad blood. If you ever want to come back, your data and history are preserved for 30 days after the access end date.</p>`;

  return `<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1a1a1a;">
  <h2 style="color: #0a0a0a;">Your HeyHenry refund</h2>
  <p>${greeting}</p>
  ${body}
  <p>— Jonathan</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  ${brandingFooterHtml('refund_confirmation')}
</body>
</html>`;
}
