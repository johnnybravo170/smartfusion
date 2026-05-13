import { brandingFooterHtml, brandingLogoHtml } from '@/lib/email/branding';
import { escapeHtml, safeUrl } from '@/lib/email/escape';

function docFieldBlock(title: string, body: string | null | undefined): string {
  if (!body || body.trim().length === 0) return '';
  return `<div style="background: #f9fafb; border: 1px solid #e5e7eb; padding: 14px 16px; margin: 16px 0; border-radius: 6px;">
    <p style="color: #111827; font-size: 13px; font-weight: 600; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 0.04em;">${escapeHtml(title)}</p>
    <p style="color: #374151; font-size: 14px; margin: 0; white-space: pre-wrap;">${escapeHtml(body.trim())}</p>
  </div>`;
}

export function invoiceEmailHtml({
  customerName,
  businessName,
  logoUrl,
  invoiceNumber,
  totalFormatted,
  payUrl,
  customerNote,
  hasStripe = true,
  paymentInstructions,
  terms,
  policies,
}: {
  customerName: string;
  businessName: string;
  logoUrl?: string | null;
  invoiceNumber: string;
  totalFormatted: string;
  payUrl: string;
  customerNote?: string | null;
  hasStripe?: boolean;
  paymentInstructions?: string | null;
  terms?: string | null;
  policies?: string | null;
}): string {
  const noteBlock = customerNote
    ? `<div style="background: #f9fafb; border-left: 3px solid #d1d5db; padding: 12px 16px; margin: 16px 0; border-radius: 4px;">
    <p style="color: #374151; font-size: 14px; margin: 0; white-space: pre-wrap;">${escapeHtml(customerNote)}</p>
  </div>`
    : '';

  const buttonLabel = hasStripe ? 'Pay Now' : 'View Invoice';
  const safeNumber = escapeHtml(invoiceNumber);
  const footerNote = hasStripe
    ? `Invoice #${safeNumber}. Payment is processed securely via Stripe.`
    : `Invoice #${safeNumber}.`;

  return `<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  ${brandingLogoHtml(logoUrl, businessName)}
  <h2 style="color: #0a0a0a;">Invoice from ${escapeHtml(businessName)}</h2>
  <p>Hi ${escapeHtml(customerName.split(' ')[0])},</p>
  <p>${escapeHtml(businessName)} has sent you an invoice for <strong>${escapeHtml(totalFormatted)}</strong>.</p>
  ${noteBlock}
  ${docFieldBlock('How to pay', paymentInstructions)}
  <p>
    <a href="${safeUrl(payUrl)}" style="display: inline-block; padding: 12px 24px; background: #0a0a0a; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">
      ${buttonLabel}
    </a>
  </p>
  ${docFieldBlock('Terms', terms)}
  ${docFieldBlock('Policies', policies)}
  <p style="color: #666; font-size: 14px;">${footerNote}</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  ${brandingFooterHtml('invoice')}
</body>
</html>`;
}
