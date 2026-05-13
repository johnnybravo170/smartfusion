import { brandingFooterHtml, brandingLogoHtml } from '@/lib/email/branding';
import { escapeHtml, safeUrl } from '@/lib/email/escape';

// TODO(email-shell): migrate to renderEmailShell on next touch
export function quoteEmailHtml({
  customerName,
  businessName,
  logoUrl,
  quoteNumber,
  totalFormatted,
  viewUrl,
  validityDays = 30,
}: {
  customerName: string;
  businessName: string;
  logoUrl?: string | null;
  quoteNumber: string;
  totalFormatted: string;
  viewUrl: string;
  validityDays?: number;
}): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  ${brandingLogoHtml(logoUrl, businessName)}
  <h2 style="color: #0a0a0a;">Estimate from ${escapeHtml(businessName)}</h2>
  <p>Hi ${escapeHtml(customerName.split(' ')[0])},</p>
  <p>${escapeHtml(businessName)} has prepared an estimate for <strong>${escapeHtml(totalFormatted)}</strong>.</p>
  <p>
    <a href="${safeUrl(viewUrl)}" style="display: inline-block; padding: 12px 24px; background: #0a0a0a; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">
      View Estimate
    </a>
  </p>
  <p style="color: #666; font-size: 14px;">You can accept or decline this estimate from the link above.</p>
  <p style="color: #666; font-size: 14px;">Estimate #${escapeHtml(quoteNumber)} is valid for ${validityDays} days. Final pricing may vary based on site conditions.</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  ${brandingFooterHtml('quote')}
</body>
</html>`;
}
