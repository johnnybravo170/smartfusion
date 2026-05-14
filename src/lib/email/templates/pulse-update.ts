import { brandingFooterHtml, brandingLogoHtml } from '@/lib/email/branding';
import { escapeHtml, safeUrl } from '@/lib/email/escape';

/**
 * Project Pulse — homeowner-facing progress email. The body is the same
 * plain-text glyph format the public /pulse/<code> page renders, so the
 * email and the web view feel like the same artifact.
 */
// TODO(email-shell): migrate to renderEmailShell on next touch
export function pulseUpdateEmailHtml({
  businessName,
  logoUrl,
  projectName,
  bodyText,
  publicUrl,
}: {
  businessName: string;
  logoUrl?: string | null;
  projectName: string;
  bodyText: string;
  publicUrl: string;
}): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1a1a1a;">
  ${brandingLogoHtml(logoUrl, businessName)}
  <h2 style="color: #0a0a0a; margin-bottom: 4px;">Project update</h2>
  <p style="color: #666; font-size: 14px; margin-top: 0;">${escapeHtml(projectName)} — from ${escapeHtml(businessName)}</p>

  <pre style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; line-height: 1.6; white-space: pre-wrap; background: #fafafa; border: 1px solid #eee; border-radius: 8px; padding: 16px; color: #1a1a1a;">${escapeHtml(bodyText)}</pre>

  <p>
    <a href="${safeUrl(publicUrl)}" style="display: inline-block; padding: 12px 24px; background: #0a0a0a; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">
      View Online
    </a>
  </p>

  <p style="font-size: 13px; color: #666;">Bookmark the link to check back any time. No login required.</p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  ${brandingFooterHtml('pulse_update')}
</body>
</html>`;
}
