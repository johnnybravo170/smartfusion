/**
 * Email sent to the operator when a customer posts a message in the
 * portal. Inlines the message body so the operator gets the gist
 * without clicking through. Matches the visual style of the estimate
 * feedback notification (-apple-system stack, 520px, emerald CTA).
 */

import { escapeHtml, safeUrl } from '@/lib/email/escape';

export function projectMessageOperatorNotificationHtml(params: {
  customerName: string;
  projectName: string;
  projectUrl: string;
  body: string;
}): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111;">
  <p style="font-size:16px;margin:0 0 8px 0;">💬 <strong>${escapeHtml(params.customerName)} sent you a message.</strong></p>
  <p style="font-size:14px;color:#555;margin:0 0 20px 0;">
    Project: <strong>${escapeHtml(params.projectName)}</strong>
  </p>
  <div style="margin:0 0 10px 0;border-left:3px solid #10b981;padding:10px 14px;background:#f9fafb;border-radius:4px;">
    <p style="font-size:14px;color:#222;margin:0;white-space:pre-wrap;line-height:1.45;">${escapeHtml(params.body)}</p>
  </div>
  <p style="margin:20px 0 24px 0;">
    <a href="${safeUrl(params.projectUrl)}" style="display:inline-block;padding:10px 16px;background:#10b981;color:#fff;text-decoration:none;border-radius:6px;font-weight:500;">
      Reply in HeyHenry
    </a>
  </p>
  <p style="font-size:12px;color:#888;margin-top:32px;border-top:1px solid #eee;padding-top:16px;">
    You're receiving this because a customer sent a message through your project portal.
  </p>
</body>
</html>`;
}
