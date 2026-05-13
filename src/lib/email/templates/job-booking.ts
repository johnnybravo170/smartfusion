import { brandingFooterHtml, brandingLogoHtml } from '@/lib/email/branding';
import { escapeHtml } from '@/lib/email/escape';

// TODO(email-shell): migrate to renderEmailShell on next touch
export function bookingEmailHtml({
  customerName,
  businessName,
  logoUrl,
  date,
  time,
  address,
}: {
  customerName: string;
  businessName: string;
  logoUrl?: string | null;
  date: string;
  time: string;
  address?: string;
}): string {
  const addressLine = address ? `<p>Location: ${escapeHtml(address)}</p>` : '';

  return `<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  ${brandingLogoHtml(logoUrl, businessName)}
  <h2 style="color: #0a0a0a;">Appointment confirmed</h2>
  <p>Hi ${escapeHtml(customerName.split(' ')[0])},</p>
  <p><strong>${escapeHtml(businessName)}</strong> has booked your appointment for <strong>${escapeHtml(date)}</strong> at <strong>${escapeHtml(time)}</strong>.</p>
  ${addressLine}
  <p>We'll see you then!</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  ${brandingFooterHtml('job_booking')}
</body>
</html>`;
}

export function cancellationEmailHtml({
  customerName,
  businessName,
  logoUrl,
  date,
  time,
}: {
  customerName: string;
  businessName: string;
  logoUrl?: string | null;
  date: string;
  time: string;
}): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  ${brandingLogoHtml(logoUrl, businessName)}
  <h2 style="color: #0a0a0a;">Appointment cancelled</h2>
  <p>Hi ${escapeHtml(customerName.split(' ')[0])},</p>
  <p>Your appointment with <strong>${escapeHtml(businessName)}</strong> on <strong>${escapeHtml(date)}</strong> at <strong>${escapeHtml(time)}</strong> has been cancelled.</p>
  <p>If you have any questions, please reach out directly.</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  ${brandingFooterHtml('job_booking')}
</body>
</html>`;
}
