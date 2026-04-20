export function estimateApprovalEmailHtml({
  businessName,
  projectName,
  totalFormatted,
  approveUrl,
  customerName,
}: {
  businessName: string;
  projectName: string;
  totalFormatted: string;
  approveUrl: string;
  customerName: string;
}): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1a1a1a;">
  <h2 style="color: #0a0a0a; margin-bottom: 4px;">Your estimate is ready</h2>
  <p style="color: #666; font-size: 14px; margin-top: 0;">From ${businessName}</p>

  <p style="font-size: 15px; line-height: 1.6;">Hi ${customerName},</p>
  <p style="font-size: 15px; line-height: 1.6;">
    Please review the estimate for <strong>${projectName}</strong>. You can approve or decline online.
  </p>

  <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 24px 0; text-align: center;">
    <p style="font-size: 12px; color: #666; margin: 0;">Estimate Total</p>
    <p style="font-size: 28px; font-weight: 600; margin: 6px 0 0;">${totalFormatted}</p>
  </div>

  <p>
    <a href="${approveUrl}" style="display: inline-block; padding: 12px 24px; background: #0a0a0a; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">
      Review Estimate
    </a>
  </p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  <p style="color: #999; font-size: 12px;">Sent via HeyHenry</p>
</body>
</html>`;
}
