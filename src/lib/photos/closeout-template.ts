/**
 * Closeout email template — draft copy for the closeout loop.
 *
 * Rendered by the AR engine when a `job_completed` event fires. Most
 * conditional rendering is done server-side in the closeout handler, which
 * passes in pre-rendered HTML blocks so this template stays a flat merge.
 *
 * Merge tags:
 *   {{first_name}}           customer first name
 *   {{business_name}}        operator's business name
 *   {{surface_summary}}      short phrase, e.g. "driveway" or "front walk and deck"
 *   {{gallery_url}}          live gallery share link (no-login)
 *   {{primary_before_url}}   signed URL of the primary before photo
 *   {{primary_after_url}}    signed URL of the primary after photo
 *   {{logo_html}}            pre-rendered <img> tag for the business logo,
 *                            or empty string if no logo uploaded
 *   {{review_html}}          pre-rendered review block (header + link), or
 *                            empty string if no review URL configured
 *   {{operator_line_html}}   pre-rendered operator signoff line ("Jonathan,
 *                            Owner"), or empty string if the tenant has no
 *                            operator name on file
 *   (plain-text variants): {{logo_text}}, {{review_text}}, {{operator_line_text}}
 *
 * Tone: short, warm, tradesperson voice. NOT marketing copy. The photos do
 * the talking.
 */

import type { NewArTemplate } from '@/lib/db/schema/ar/templates';

export const CLOSEOUT_EMAIL_SUBJECT =
  '{{first_name}}, your {{surface_summary}} is done — take a look';

export const CLOSEOUT_EMAIL_BODY_HTML = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111">
<div style="max-width:560px;margin:24px auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb">

  {{logo_html}}

  <div style="padding:28px 28px 0">
    <p style="margin:0 0 16px;font-size:16px;line-height:1.5">Hi {{first_name}},</p>
    <p style="margin:0 0 20px;font-size:16px;line-height:1.5">
      All wrapped up on your {{surface_summary}} today. Here's the quick look:
    </p>
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
    <tr>
      <td style="width:50%;padding:0 4px 0 28px">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#6b7280;margin-bottom:6px">Before</div>
        <img src="{{primary_before_url}}" alt="Before" style="width:100%;border-radius:12px;display:block" />
      </td>
      <td style="width:50%;padding:0 28px 0 4px">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#059669;margin-bottom:6px">After</div>
        <img src="{{primary_after_url}}" alt="After" style="width:100%;border-radius:12px;display:block" />
      </td>
    </tr>
  </table>

  <div style="padding:24px 28px 8px">
    <a href="{{gallery_url}}" style="display:inline-block;padding:12px 20px;background:#111827;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:600;font-size:15px">
      See the full gallery →
    </a>
    <p style="margin:16px 0 0;font-size:13px;color:#6b7280;line-height:1.5">
      Every photo is timestamped and kept on file — it's here whenever you need it.
    </p>
  </div>

  <div style="padding:0 28px 28px">
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0" />
    {{review_html}}
    <p style="margin:0;font-size:14px;line-height:1.5;color:#374151">
      Thanks,<br />
      {{operator_line_html}}<span style="font-weight:600">{{business_name}}</span>
    </p>
  </div>

</div>

<div style="max-width:560px;margin:0 auto 24px;padding:0 28px;font-size:11px;color:#9ca3af;text-align:center;line-height:1.5">
  Reply to this email — {{business_name}} will get it directly.<br />
  <a href="{{unsubscribe_url}}" style="color:#9ca3af;text-decoration:underline">Unsubscribe</a>
</div>

</body></html>`;

export const CLOSEOUT_EMAIL_BODY_TEXT = `Hi {{first_name}},

All wrapped up on your {{surface_summary}} today.

See the full gallery (before/after + everything we captured):
{{gallery_url}}

Every photo is timestamped and kept on file — it's here whenever you need it.
{{review_text}}
Thanks,
{{operator_line_text}}{{business_name}}

---
Reply to this email — {{business_name}} will get it directly.
Unsubscribe: {{unsubscribe_url}}`;

/**
 * Pre-rendered blocks that the closeout handler populates per-tenant.
 */
export type CloseoutRenderChunks = {
  logo_html: string;
  review_html: string;
  review_text: string;
  operator_line_html: string;
  operator_line_text: string;
};

export function buildLogoBlock(logoUrl: string | null): string {
  if (!logoUrl) return '';
  return `<div style="padding:24px 28px 0;text-align:left"><img src="${escapeAttr(logoUrl)}" alt="" style="max-height:48px;max-width:200px;display:block" /></div>`;
}

export function buildReviewBlock(reviewUrl: string | null): {
  html: string;
  text: string;
} {
  if (!reviewUrl) return { html: '', text: '' };
  return {
    html: `<p style="margin:0 0 8px;font-size:14px;line-height:1.5">If we earned it, a quick review goes a long way:</p>
    <p style="margin:0 0 16px">
      <a href="${escapeAttr(reviewUrl)}" style="color:#2563eb;text-decoration:none;font-weight:500">Leave a review</a>
    </p>`,
    text: `\nIf we earned it, a quick review goes a long way:\n${reviewUrl}\n`,
  };
}

export function buildOperatorLine(
  firstName: string | null,
  lastName: string | null,
  title: string | null,
): { html: string; text: string } {
  const name = [firstName, lastName].filter(Boolean).join(' ').trim();
  if (!name) return { html: '', text: '' };
  const label = title ? `${name}, ${title}` : name;
  return {
    html: `${escapeHtml(label)}<br />`,
    text: `${label}\n`,
  };
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;');
}

/**
 * Build the ar_templates row insert shape for a tenant's closeout template.
 * Used by the Phase 3 seed helper when an operator turns on the closeout
 * loop. Keeps the copy in one place instead of baked into a SQL seed.
 */
export function buildCloseoutTemplate(params: {
  tenantId: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string | null;
}): NewArTemplate {
  return {
    tenantId: params.tenantId,
    name: 'Closeout — job complete',
    channel: 'email',
    subject: CLOSEOUT_EMAIL_SUBJECT,
    bodyHtml: CLOSEOUT_EMAIL_BODY_HTML,
    bodyText: CLOSEOUT_EMAIL_BODY_TEXT,
    fromName: params.fromName,
    fromEmail: params.fromEmail,
    replyTo: params.replyTo ?? params.fromEmail,
  };
}

/**
 * Closeout sequence definition.
 *
 * Triggered by an AR event of type `job_completed`. A single email step
 * with no delay — the AR dispatcher still honors quiet hours, so the
 * email won't fire at 11pm just because the operator happened to tap
 * Complete at 11pm.
 */
export function buildCloseoutSequenceDef(params: { tenantId: string; templateId: string }) {
  return {
    sequence: {
      tenantId: params.tenantId,
      name: 'Closeout',
      description:
        'Sends a branded before/after + gallery link to the customer as soon as the job is marked Complete.',
      status: 'active' as const,
      triggerType: 'event' as const,
      triggerConfig: { event_type: 'job_completed' },
      allowReenrollment: true,
    },
    steps: [
      {
        position: 0,
        type: 'email' as const,
        delayMinutes: 0,
        templateId: params.templateId,
      },
    ],
  };
}
