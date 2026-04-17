export function quoteEmailHtml({
  customerName,
  businessName,
  quoteNumber,
  totalFormatted,
  viewUrl,
}: {
  customerName: string;
  businessName: string;
  quoteNumber: string;
  totalFormatted: string;
  viewUrl: string;
}): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #0a0a0a;">Quote from ${businessName}</h2>
  <p>Hi ${customerName},</p>
  <p>${businessName} has sent you a quote for <strong>${totalFormatted}</strong>.</p>
  <p>
    <a href="${viewUrl}" style="display: inline-block; padding: 12px 24px; background: #0a0a0a; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">
      View Quote
    </a>
  </p>
  <p style="color: #666; font-size: 14px;">Quote #${quoteNumber} is valid for 30 days.</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  <p style="color: #999; font-size: 12px;">Sent via HeyHenry</p>
</body>
</html>`;
}
