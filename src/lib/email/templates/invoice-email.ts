export function invoiceEmailHtml({
  customerName,
  businessName,
  invoiceNumber,
  totalFormatted,
  payUrl,
}: {
  customerName: string;
  businessName: string;
  invoiceNumber: string;
  totalFormatted: string;
  payUrl: string;
}): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #0a0a0a;">Invoice from ${businessName}</h2>
  <p>Hi ${customerName.split(' ')[0]},</p>
  <p>${businessName} has sent you an invoice for <strong>${totalFormatted}</strong>.</p>
  <p>
    <a href="${payUrl}" style="display: inline-block; padding: 12px 24px; background: #0a0a0a; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">
      Pay Now
    </a>
  </p>
  <p style="color: #666; font-size: 14px;">Invoice #${invoiceNumber}. Payment is processed securely via Stripe.</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  <p style="color: #999; font-size: 12px;">Sent via HeyHenry</p>
</body>
</html>`;
}
