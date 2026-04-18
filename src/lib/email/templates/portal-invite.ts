export function portalInviteEmailHtml({
  businessName,
  projectName,
  customerName,
  portalUrl,
}: {
  businessName: string;
  projectName: string;
  customerName: string;
  portalUrl: string;
}): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1a1a1a;">
  <h2 style="color: #0a0a0a;">Your Project Portal</h2>
  <p>Hi ${customerName},</p>
  <p>${businessName} has set up a project portal for <strong>${projectName}</strong>. You can track your project's progress at any time.</p>

  <p>
    <a href="${portalUrl}" style="display: inline-block; padding: 12px 24px; background: #0a0a0a; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">
      View Your Project
    </a>
  </p>

  <p style="font-size: 14px; color: #666;">Bookmark this link to check back anytime. No login required.</p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  <p style="color: #999; font-size: 12px;">Sent via HeyHenry</p>
</body>
</html>`;
}
