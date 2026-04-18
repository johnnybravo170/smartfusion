export function changeOrderApprovalEmailHtml({
  businessName,
  projectName,
  changeOrderTitle,
  description,
  costImpactFormatted,
  timelineImpactDays,
  approveUrl,
}: {
  businessName: string;
  projectName: string;
  changeOrderTitle: string;
  description: string;
  costImpactFormatted: string;
  timelineImpactDays: number;
  approveUrl: string;
}): string {
  const timelineText =
    timelineImpactDays === 0
      ? 'No change to timeline'
      : timelineImpactDays > 0
        ? `+${timelineImpactDays} day${timelineImpactDays === 1 ? '' : 's'} to timeline`
        : `${timelineImpactDays} day${Math.abs(timelineImpactDays) === 1 ? '' : 's'} from timeline`;

  return `<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1a1a1a;">
  <h2 style="color: #0a0a0a; margin-bottom: 4px;">Change Order for ${projectName}</h2>
  <p style="color: #666; font-size: 14px; margin-top: 0;">From ${businessName}</p>

  <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 24px 0;">
    <h3 style="margin-top: 0; font-size: 16px;">${changeOrderTitle}</h3>
    <p style="font-size: 14px; line-height: 1.6;">${description}</p>

    <div style="display: flex; gap: 24px; margin-top: 16px;">
      <div>
        <p style="font-size: 12px; color: #666; margin: 0;">Cost Impact</p>
        <p style="font-size: 18px; font-weight: 600; margin: 4px 0 0;">${costImpactFormatted}</p>
      </div>
      <div>
        <p style="font-size: 12px; color: #666; margin: 0;">Timeline Impact</p>
        <p style="font-size: 18px; font-weight: 600; margin: 4px 0 0;">${timelineText}</p>
      </div>
    </div>
  </div>

  <p style="font-size: 14px;">Please review and approve or decline this change order:</p>

  <p>
    <a href="${approveUrl}" style="display: inline-block; padding: 12px 24px; background: #0a0a0a; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">
      Review &amp; Respond
    </a>
  </p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  <p style="color: #999; font-size: 12px;">Sent via HeyHenry</p>
</body>
</html>`;
}
