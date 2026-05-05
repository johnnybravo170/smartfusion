import type { CaslCategory } from '@/lib/db/schema/casl';
import { createAdminClient } from '@/lib/supabase/admin';
import { FROM_EMAIL, getResend } from './client';
import { getTenantFromHeader } from './from';
import { htmlToPlainText } from './html-to-text';

export type EmailAttachment = {
  filename: string;
  content: Buffer;
  contentType?: string;
};

export type SendEmailRelatedType =
  | 'estimate'
  | 'change_order'
  | 'invoice'
  | 'job'
  | 'home_record'
  | 'billing'
  | 'auth'
  | 'team'
  | 'platform'
  | 'onboarding'
  | 'referral'
  | 'lead'
  | 'pulse'
  | 'time_nudge'
  | 'feedback'
  | 'other';

/**
 * Send an email via Resend.
 *
 * **CASL contract:** every send must declare a `caslCategory`. The category
 * gates how we audit the message later and whether it needs CEM-form
 * compliance (sender ID, address, unsubscribe).
 *
 * - `transactional`            — invoice, receipt, appointment, completion, auth
 * - `response_to_request`      — direct reply to an inbound inquiry
 * - `implied_consent_inquiry`  — promotional, ≤6mo since inquiry  (CEM)
 * - `implied_consent_ebr`      — promotional, ≤2y since paid job  (CEM)
 * - `express_consent`          — newsletter / drip                (CEM)
 * - `unclassified`             — TEMP for legacy callsites; phase B replaces
 *
 * **CEM categories must come from the AR engine.** The AR executor
 * (`src/lib/ar/executor.ts`) is the only legitimate caller that passes a
 * CEM category — it handles RFC 8058 unsubscribe headers, suppression
 * checks, and engagement webhooks. New non-AR code that needs to send
 * promotional content must build an AR sequence, not call sendEmail
 * directly with a CEM category.
 *
 * Every call is logged to `email_send_log` regardless of outcome (queued
 * row first, then updated with provider id / status).
 *
 * Preferred: pass `tenantId` and the From header will be built as
 * `"<Business Name>" <platform-address>` with `Reply-To` set to the
 * tenant's contact_email. Callers don't need to fetch the tenant profile
 * themselves.
 *
 * Explicit `from` / `replyTo` still win when provided, useful for system
 * emails (platform admin notices, auth) where the platform is the sender.
 *
 * `caslEvidence` is a free-form jsonb blob stored alongside the send for
 * later audit. Suggested shape per category:
 *   - transactional         → { invoiceId } | { estimateId } | { jobId } | etc
 *   - response_to_request   → { inquiryId, inquirySource, inquiryAt }
 *   - implied_consent_*     → { inquiryId | lastPaidJobId, asOf }
 *   - express_consent       → { consentEventId }
 */
export async function sendEmail({
  to,
  subject,
  html,
  text,
  from,
  replyTo,
  attachments,
  tenantId,
  headers,
  caslCategory,
  caslEvidence,
  relatedType,
  relatedId,
}: {
  to: string;
  subject: string;
  html: string;
  /** Optional override for the plain-text alternative. When omitted,
   *  one is auto-generated from `html`. Modern spam filters
   *  (Gmail/Outlook in particular) downweight HTML-only emails;
   *  always shipping both parts is a free deliverability win. */
  text?: string;
  from?: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
  tenantId?: string;
  headers?: Record<string, string>;
  caslCategory: CaslCategory;
  caslEvidence?: Record<string, unknown>;
  relatedType?: SendEmailRelatedType;
  relatedId?: string;
}): Promise<{ ok: boolean; error?: string; id?: string }> {
  let resolvedFrom = from || FROM_EMAIL;
  let resolvedReplyTo = replyTo;

  if (tenantId && !from) {
    try {
      const tenantHeader = await getTenantFromHeader(tenantId);
      resolvedFrom = tenantHeader.from;
      resolvedReplyTo = replyTo ?? tenantHeader.replyTo;
    } catch (e) {
      // Fall back to platform default if tenant lookup fails — don't block the send.
      const _err = e instanceof Error ? e.message : String(e);
      void _err;
    }
  }

  // 1. Pre-log as queued so we have an audit row even if Resend throws.
  const supabase = createAdminClient();
  const { data: row, error: insertErr } = await supabase
    .from('email_send_log')
    .insert({
      tenant_id: tenantId ?? null,
      direction: 'outbound',
      to_address: to,
      from_address: resolvedFrom,
      reply_to: resolvedReplyTo ?? null,
      subject,
      casl_category: caslCategory,
      casl_evidence: caslEvidence ?? null,
      related_type: relatedType ?? null,
      related_id: relatedId ?? null,
      status: 'queued',
    })
    .select('id')
    .single();

  if (insertErr || !row) {
    return { ok: false, error: `email_send_log insert failed: ${insertErr?.message ?? 'unknown'}` };
  }

  // 2. Fire the Resend API call.
  try {
    const resend = getResend();
    const resolvedText = text ?? htmlToPlainText(html);
    const { data, error } = await resend.emails.send({
      from: resolvedFrom,
      to,
      subject,
      html,
      text: resolvedText || undefined,
      replyTo: resolvedReplyTo,
      headers,
      attachments: attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        content_type: a.contentType,
      })),
    });

    if (error) {
      await supabase
        .from('email_send_log')
        .update({
          status: 'failed',
          error_message: error.message,
        })
        .eq('id', row.id);
      return { ok: false, error: error.message };
    }

    await supabase
      .from('email_send_log')
      .update({
        provider_id: data?.id ?? null,
        status: 'sent',
        sent_at: new Date().toISOString(),
      })
      .eq('id', row.id);

    return { ok: true, id: data?.id };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown email error';
    await supabase
      .from('email_send_log')
      .update({ status: 'failed', error_message: msg })
      .eq('id', row.id);
    return { ok: false, error: msg };
  }
}
