/**
 * Email sent to the operator when a customer accepts their estimate from
 * the public approval page. Mirrors the visual style of
 * `estimate-viewed-notification` but with stronger copy + an emerald CTA
 * since this is the bigger news.
 */

import { escapeHtml, safeUrl } from '@/lib/email/escape';

// TODO(email-shell): migrate to renderEmailShell on next touch
export function estimateAcceptedEmailHtml(params: {
  customerName: string | null;
  projectName: string;
  projectUrl: string;
  businessName: string;
}): string {
  const who = params.customerName ?? 'Your customer';
  return `<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111;">
  <p style="font-size:16px;margin:0 0 8px 0;">🎉 <strong>${escapeHtml(who)} approved your estimate!</strong></p>
  <p style="font-size:14px;color:#555;margin:0 0 16px 0;">
    Project: <strong>${escapeHtml(params.projectName)}</strong>
  </p>
  <p style="font-size:14px;color:#333;margin:0 0 20px 0;">
    Time to schedule the work and kick things off.
  </p>
  <p style="margin:0 0 24px 0;">
    <a href="${safeUrl(params.projectUrl)}" style="display:inline-block;padding:10px 16px;background:#10b981;color:#fff;text-decoration:none;border-radius:6px;font-weight:500;">
      Open the project
    </a>
  </p>
  <p style="font-size:12px;color:#888;margin-top:32px;border-top:1px solid #eee;padding-top:16px;">
    You're receiving this because ${escapeHtml(params.businessName)} sent an estimate through HeyHenry and the customer just approved it.
  </p>
</body>
</html>`;
}
