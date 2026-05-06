/**
 * Email template for referral invitations.
 *
 * Sent when an owner invites another contractor to try HeyHenry.
 * Follows the same inline-style HTML pattern as invoice-email.ts.
 */

export function referralInviteHtml({
  referrerName,
  referralUrl,
}: {
  referrerName: string;
  referralUrl: string;
}): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #0a0a0a;">${referrerName} thinks you'd love HeyHenry</h2>
  <p>Hey there,</p>
  <p>${referrerName} uses HeyHenry to run their contracting business and thought you'd find it useful too.</p>
  <p>HeyHenry helps contractors manage quotes, jobs, invoices, and customers in one place. No spreadsheets, no juggling apps.</p>
  <p>
    <a href="${referralUrl}" style="display: inline-block; padding: 12px 24px; background: #0a0a0a; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">
      Start your free 14-day trial
    </a>
  </p>
  <p style="color: #666; font-size: 14px;">Your extended trial is courtesy of ${referrerName}'s referral. No credit card required to get started.</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  <p style="color: #999; font-size: 12px;"><a href="https://heyhenry.io/?utm_source=tenant_email&amp;utm_medium=referral&amp;utm_campaign=sent_via_footer&amp;utm_content=referral_invite" style="color:inherit;text-decoration:none">Powered by HeyHenry</a></p>
</body>
</html>`;
}

export function referralInviteSubject(referrerName: string): string {
  return `${referrerName} thinks you'd love HeyHenry`;
}

/**
 * SMS body for referral invitations. Kept short so it fits a single
 * 160-char segment when the referrer name is reasonable.
 */
export function referralInviteSms({
  referrerName,
  referralUrl,
}: {
  referrerName: string;
  referralUrl: string;
}): string {
  return `${referrerName} invited you to try HeyHenry — quotes, jobs & invoices in one place. ${referralUrl}`;
}
