/**
 * Closeout email template — draft copy for the closeout loop.
 *
 * Rendered by the AR engine when a `job_completed` event fires. Merge tags
 * are resolved from the event payload:
 *
 *   {{first_name}}           customer first name
 *   {{business_name}}        operator's business name
 *   {{surface_summary}}      short phrase, e.g. "driveway" or "front walk and deck"
 *   {{city}}                 customer's city
 *   {{gallery_url}}          live gallery share link (no-login)
 *   {{primary_before_url}}   signed/public URL of the primary before photo
 *   {{primary_after_url}}    signed/public URL of the primary after photo
 *   {{review_url}}           Review URL the operator points people at
 *
 * Tone: short, warm, tradesperson voice. NOT marketing copy. The photos
 * do the talking. Subject matches the "sounds like a real person" rule
 * from the Social Poster Voice spec.
 */

import type { NewArTemplate } from '@/lib/db/schema/ar/templates';

export const CLOSEOUT_EMAIL_SUBJECT =
  '{{first_name}}, your {{surface_summary}} is done — take a look';

export const CLOSEOUT_EMAIL_BODY_HTML = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111">
<div style="max-width:560px;margin:24px auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb">

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
    <p style="margin:0 0 8px;font-size:14px;line-height:1.5">
      If we earned it, a quick review goes a long way:
    </p>
    <p style="margin:0 0 16px">
      <a href="{{review_url}}" style="color:#2563eb;text-decoration:none;font-weight:500">Leave a review</a>
    </p>
    <p style="margin:0;font-size:14px;line-height:1.5;color:#374151">
      Thanks,<br />
      <span style="font-weight:600">{{business_name}}</span>
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

If we earned it, a quick review goes a long way:
{{review_url}}

Thanks,
{{business_name}}

---
Reply to this email — {{business_name}} will get it directly.
Unsubscribe: {{unsubscribe_url}}`;

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
 * Closeout sequence definition (Phase 3 wiring).
 *
 * Triggered by an AR event of type `job_completed`. A single email step
 * with no delay — the AR dispatcher still honors quiet hours, so the
 * email won't fire at 11pm just because the operator happened to tap
 * Complete at 11pm.
 *
 * Returned here as a plain object so Phase 3 can insert + link it via
 * the existing ar_sequences / ar_steps tables without repeating shape
 * knowledge across the codebase.
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
      allowReenrollment: true, // each job is its own closeout
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
