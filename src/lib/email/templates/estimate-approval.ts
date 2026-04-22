import { brandingFooterHtml, brandingLogoHtml } from '@/lib/email/branding';

export function estimateApprovalEmailHtml({
  businessName,
  logoUrl,
  projectName,
  approveUrl,
  customerName,
  note,
}: {
  businessName: string;
  logoUrl?: string | null;
  projectName: string;
  approveUrl: string;
  customerName: string;
  note?: string | null;
}): string {
  const noteHtml = note?.trim()
    ? `<p style="font-size: 15px; line-height: 1.6; white-space: pre-wrap;">${note.trim()}</p>`
    : '';

  return `<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1a1a1a;">
  ${brandingLogoHtml(logoUrl, businessName)}
  <h2 style="color: #0a0a0a; margin-bottom: 4px;">Your estimate is ready</h2>
  <p style="color: #666; font-size: 14px; margin-top: 0;">From ${businessName}</p>

  <p style="font-size: 15px; line-height: 1.6;">Hi ${customerName},</p>
  <p style="font-size: 15px; line-height: 1.6;">
    Your estimate for <strong>${projectName}</strong> is ready. Click below to review the details and approve or decline.
  </p>
  ${noteHtml}

  <p>
    <a href="${approveUrl}" style="display: inline-block; padding: 12px 24px; background: #0a0a0a; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">
      Review Estimate
    </a>
  </p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  ${brandingFooterHtml('estimate')}
</body>
</html>`;
}
