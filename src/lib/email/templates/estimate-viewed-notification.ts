/**
 * Email sent to the operator the first time a customer opens their
 * estimate. Minimal: celebratory subject line, one-line body, link to
 * the project.
 */

export function estimateViewedEmailHtml(params: {
  customerName: string | null;
  projectName: string;
  projectUrl: string;
  businessName: string;
}): string {
  const who = params.customerName ?? 'Your customer';
  return `<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111;">
  <p style="font-size:16px;margin:0 0 8px 0;">🎉 <strong>${escapeHtml(who)} just opened your estimate.</strong></p>
  <p style="font-size:14px;color:#555;margin:0 0 16px 0;">
    Project: <strong>${escapeHtml(params.projectName)}</strong>
  </p>
  <p style="margin:0 0 24px 0;">
    <a href="${params.projectUrl}" style="display:inline-block;padding:10px 16px;background:#10b981;color:#fff;text-decoration:none;border-radius:6px;font-weight:500;">
      View estimate status
    </a>
  </p>
  <p style="font-size:12px;color:#888;margin-top:32px;border-top:1px solid #eee;padding-top:16px;">
    You're receiving this because ${escapeHtml(params.businessName)} sent an estimate through HeyHenry and the customer just opened it.
  </p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Heuristic bot / scanner detector. Returns true if the user-agent
 * looks like an email link scanner (Microsoft SafeLinks, Google's link
 * preview, Proofpoint, etc.) rather than a real customer's browser.
 *
 * Over-matches rather than under-matches — a missed notification is
 * recoverable (the banner still shows); a false-fire makes the
 * operator lose trust in the signal.
 */
export function looksLikeBot(userAgent: string | null | undefined): boolean {
  if (!userAgent) return true; // no UA = suspicious
  const ua = userAgent.toLowerCase();
  return (
    /\b(bot|crawler|spider|preview|scanner|fetcher|validator)\b/.test(ua) ||
    ua.includes('safelinks') ||
    ua.includes('headlesschrome') ||
    ua.includes('phantomjs') ||
    ua.includes('puppeteer') ||
    ua.includes('playwright') ||
    ua.includes('curl/') ||
    ua.includes('wget/') ||
    ua.includes('python-requests') ||
    ua.includes('go-http-client') ||
    ua.includes('facebookexternalhit') ||
    ua.includes('slackbot') ||
    ua.includes('discordbot') ||
    ua.includes('linkedinbot') ||
    ua.includes('twitterbot') ||
    ua.includes('whatsapp') ||
    ua.includes('googleimageproxy')
  );
}
