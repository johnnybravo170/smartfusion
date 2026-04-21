import { FROM_EMAIL, getResend } from './client';
import { getTenantFromHeader } from './from';

export type EmailAttachment = {
  filename: string;
  content: Buffer;
  contentType?: string;
};

/**
 * Send an email via Resend.
 *
 * Preferred: pass `tenantId` and the From header will be built as
 * `"<Business Name>" <platform-address>` with `Reply-To` set to the
 * tenant's contact_email. Callers don't need to fetch the tenant profile
 * themselves.
 *
 * Explicit `from` / `replyTo` still win when provided, which is useful for
 * system emails (platform admin notices, invites) and the AR engine (which
 * uses template-stored from_name/from_email).
 */
export async function sendEmail({
  to,
  subject,
  html,
  from,
  replyTo,
  attachments,
  tenantId,
  headers,
}: {
  to: string;
  subject: string;
  html: string;
  from?: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
  tenantId?: string;
  headers?: Record<string, string>;
}): Promise<{ ok: boolean; error?: string; id?: string }> {
  try {
    let resolvedFrom = from || FROM_EMAIL;
    let resolvedReplyTo = replyTo;

    if (tenantId && !from) {
      const tenantHeader = await getTenantFromHeader(tenantId);
      resolvedFrom = tenantHeader.from;
      resolvedReplyTo = replyTo ?? tenantHeader.replyTo;
    }

    const resend = getResend();
    const { data, error } = await resend.emails.send({
      from: resolvedFrom,
      to,
      subject,
      html,
      replyTo: resolvedReplyTo,
      headers,
      attachments: attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        content_type: a.contentType,
      })),
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: data?.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Unknown email error' };
  }
}
