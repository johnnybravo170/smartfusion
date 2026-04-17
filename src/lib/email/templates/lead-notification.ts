/**
 * Email template sent to the operator when a new lead comes in
 * through the public quoting widget.
 */

export function leadNotificationHtml({
  businessName,
  customerName,
  customerEmail,
  customerPhone,
  totalFormatted,
  surfaceSummary,
  dashboardUrl,
}: {
  businessName: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  totalFormatted: string;
  surfaceSummary: string;
  dashboardUrl: string;
}): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #0a0a0a;">New quote request</h2>
  <p>Hi ${businessName},</p>
  <p>A potential customer just requested a quote through your website:</p>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr>
      <td style="padding: 8px 0; color: #666; width: 120px;">Name</td>
      <td style="padding: 8px 0; font-weight: 500;">${customerName}</td>
    </tr>
    <tr>
      <td style="padding: 8px 0; color: #666;">Email</td>
      <td style="padding: 8px 0;"><a href="mailto:${customerEmail}">${customerEmail}</a></td>
    </tr>
    <tr>
      <td style="padding: 8px 0; color: #666;">Phone</td>
      <td style="padding: 8px 0;"><a href="tel:${customerPhone}">${customerPhone}</a></td>
    </tr>
    <tr>
      <td style="padding: 8px 0; color: #666;">Estimate</td>
      <td style="padding: 8px 0; font-weight: 600;">${totalFormatted}</td>
    </tr>
    <tr>
      <td style="padding: 8px 0; color: #666; vertical-align: top;">Surfaces</td>
      <td style="padding: 8px 0;">${surfaceSummary}</td>
    </tr>
  </table>
  <p>
    <a href="${dashboardUrl}" style="display: inline-block; padding: 12px 24px; background: #0a0a0a; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">
      View in Dashboard
    </a>
  </p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  <p style="color: #999; font-size: 12px;">Sent via HeyHenry</p>
</body>
</html>`;
}
