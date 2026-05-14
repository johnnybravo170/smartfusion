import { brandingFooterHtml, brandingLogoHtml } from '@/lib/email/branding';
import { escapeHtml, safeUrl } from '@/lib/email/escape';

// TODO(email-shell): migrate to renderEmailShell on next touch
export function changeOrderApprovalEmailHtml({
  businessName,
  logoUrl,
  projectName,
  changeOrderTitle,
  description,
  costImpactFormatted,
  managementFeeFormatted,
  managementFeePct,
  totalImpactFormatted,
  timelineImpactDays,
  approveUrl,
}: {
  businessName: string;
  logoUrl?: string | null;
  projectName: string;
  changeOrderTitle: string;
  description: string;
  /** Pre-fee cost impact (signed). */
  costImpactFormatted: string;
  /** Management fee dollar amount (signed). Empty string when fee is 0. */
  managementFeeFormatted: string;
  /** Management fee rate as a display string, e.g. "12" or "8.5". */
  managementFeePct: string;
  /** cost + fee, signed. Headline number the customer sees. */
  totalImpactFormatted: string;
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
  ${brandingLogoHtml(logoUrl, businessName)}
  <h2 style="color: #0a0a0a; margin-bottom: 4px;">Change Order for ${escapeHtml(projectName)}</h2>
  <p style="color: #666; font-size: 14px; margin-top: 0;">From ${escapeHtml(businessName)}</p>

  <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 24px 0;">
    <h3 style="margin-top: 0; font-size: 16px;">${escapeHtml(changeOrderTitle)}</h3>
    <p style="font-size: 14px; line-height: 1.6;">${escapeHtml(description)}</p>

    <div style="display: flex; gap: 24px; margin-top: 16px;">
      <div>
        <p style="font-size: 12px; color: #666; margin: 0;">Total Cost Impact</p>
        <p style="font-size: 18px; font-weight: 600; margin: 4px 0 0;">${escapeHtml(totalImpactFormatted)}</p>
      </div>
      <div>
        <p style="font-size: 12px; color: #666; margin: 0;">Timeline Impact</p>
        <p style="font-size: 18px; font-weight: 600; margin: 4px 0 0;">${timelineText}</p>
      </div>
    </div>

    ${
      managementFeeFormatted
        ? `<table style="width: 100%; margin-top: 16px; border-top: 1px solid #e5e7eb; padding-top: 12px; font-size: 13px;">
      <tr>
        <td style="color: #666; padding: 2px 0;">Cost of work</td>
        <td style="text-align: right; padding: 2px 0;">${escapeHtml(costImpactFormatted)}</td>
      </tr>
      <tr>
        <td style="color: #666; padding: 2px 0;">Management fee (${escapeHtml(managementFeePct)}%)</td>
        <td style="text-align: right; padding: 2px 0;">${escapeHtml(managementFeeFormatted)}</td>
      </tr>
      <tr>
        <td style="font-weight: 600; padding: 4px 0 0; border-top: 1px solid #e5e7eb;">Total</td>
        <td style="text-align: right; font-weight: 600; padding: 4px 0 0; border-top: 1px solid #e5e7eb;">${escapeHtml(totalImpactFormatted)}</td>
      </tr>
    </table>`
        : ''
    }
  </div>

  <p style="font-size: 14px;">Please review and approve or decline this change order:</p>

  <p>
    <a href="${safeUrl(approveUrl)}" style="display: inline-block; padding: 12px 24px; background: #0a0a0a; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">
      Review &amp; Respond
    </a>
  </p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  ${brandingFooterHtml('change_order')}
</body>
</html>`;
}
