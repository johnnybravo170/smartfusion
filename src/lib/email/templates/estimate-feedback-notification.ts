/**
 * Email sent to the operator when a customer leaves feedback on a
 * pending estimate. Mirrors the visual style of the other estimate
 * notification emails (-apple-system stack, 520px, emerald CTA) and
 * inlines the actual feedback bodies so the operator gets the gist
 * without having to click through.
 */

import { escapeHtml, safeUrl } from '@/lib/email/escape';

export type FeedbackEmailComment = {
  body: string;
  isLineItem: boolean;
};

// TODO(email-shell): migrate to renderEmailShell on next touch
export function estimateFeedbackEmailHtml(params: {
  customerName: string;
  projectName: string;
  projectUrl: string;
  comments: FeedbackEmailComment[];
}): string {
  const count = params.comments.length;
  const noun = count === 1 ? 'comment' : 'comments';

  const commentsHtml = params.comments
    .map((c) => {
      const label = c.isLineItem ? 'On a line item' : 'General';
      return `
  <div style="margin:0 0 10px 0;border-left:3px solid #10b981;padding:10px 14px;background:#f9fafb;border-radius:4px;">
    <p style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#888;margin:0 0 4px 0;font-weight:600;">${label}</p>
    <p style="font-size:14px;color:#222;margin:0;white-space:pre-wrap;line-height:1.45;">${escapeHtml(c.body)}</p>
  </div>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111;">
  <p style="font-size:16px;margin:0 0 8px 0;">💬 <strong>${escapeHtml(params.customerName)} left ${count} ${noun} on your estimate.</strong></p>
  <p style="font-size:14px;color:#555;margin:0 0 20px 0;">
    Project: <strong>${escapeHtml(params.projectName)}</strong>
  </p>
  ${commentsHtml}
  <p style="margin:20px 0 24px 0;">
    <a href="${safeUrl(params.projectUrl)}" style="display:inline-block;padding:10px 16px;background:#10b981;color:#fff;text-decoration:none;border-radius:6px;font-weight:500;">
      Open the project
    </a>
  </p>
  <p style="font-size:12px;color:#888;margin-top:32px;border-top:1px solid #eee;padding-top:16px;">
    You're receiving this because a customer left feedback on an estimate you sent through HeyHenry.
  </p>
</body>
</html>`;
}

/**
 * Short SMS body — first comment excerpt, plus deep link. Stays under
 * ~300 chars so most carriers send a single segment.
 */
export function estimateFeedbackSmsBody(params: {
  customerName: string;
  comments: FeedbackEmailComment[];
  projectUrl: string;
}): string {
  const count = params.comments.length;
  const first = params.comments[0]?.body ?? '';
  const excerpt = first.length > 120 ? `${first.slice(0, 117).trimEnd()}…` : first;
  const more = count > 1 ? ` (+${count - 1} more)` : '';
  return `${params.customerName}: "${excerpt}"${more}\n${params.projectUrl}`;
}
