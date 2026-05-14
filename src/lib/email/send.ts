import { Models } from 'postmark';
import type { CaslCategory } from '@/lib/db/schema/casl';
import { createAdminClient } from '@/lib/supabase/admin';
import { isDemoTenant } from '@/lib/tenants/demo';
import {
  FROM_EMAIL,
  FROM_EMAIL_MARKETING,
  getPostmark,
  STREAM_MARKETING,
  STREAM_TENANTS,
  STREAM_TRANSACTIONAL,
} from './client';
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

const MARKETING_CASL_CATEGORIES: ReadonlySet<CaslCategory> = new Set([
  'implied_consent_inquiry',
  'implied_consent_ebr',
  'express_consent',
] as CaslCategory[]);

/**
 * Send an email via Postmark.
 *
 * **Stream routing** — every send is auto-routed to one of three streams,
 * each with its own sender reputation:
 *   - `outbound-tenants`        — when a tenant From header was applied
 *                                 (i.e. tenantId provided + no explicit `from`)
 *   - `outbound-marketing`      — when caslCategory is a CEM consent class
 *                                 (implied_consent_*, express_consent)
 *   - `outbound-transactional`  — everything else (auth, welcome, receipts,
 *                                 platform notifications)
 *
 * Tracking is also chosen by stream: opens + links ON for marketing/tenants,
 * OFF for transactional (auth-adjacent emails get pre-clicked by Gmail
 * scanners which inflates click counts and burns one-time tokens).
 *
 * **CASL contract** — every send must declare a `caslCategory`. The
 * category gates audit + CEM-form compliance:
 *   - `transactional`            — invoice, receipt, appointment, completion, auth
 *   - `response_to_request`      — direct reply to an inbound inquiry
 *   - `implied_consent_inquiry`  — promotional, ≤6mo since inquiry  (CEM)
 *   - `implied_consent_ebr`      — promotional, ≤2y since paid job  (CEM)
 *   - `express_consent`          — newsletter / drip                (CEM)
 *   - `unclassified`             — TEMP for legacy callsites; phase B replaces
 *
 * **CEM categories must come from the AR engine** (`src/lib/ar/executor.ts`)
 * which handles RFC 8058 unsubscribe headers, suppression checks, and
 * engagement webhooks. New non-AR code that needs to send promotional
 * content must build an AR sequence, not call sendEmail directly with a
 * CEM category.
 *
 * Every call is logged to `email_send_log` regardless of outcome (queued
 * row first, then updated with provider id / status).
 *
 * Preferred: pass `tenantId` and the From header is built as
 * `"<Business Name>" <noreply@tenants.heyhenry.io>` with `Reply-To` set to
 * the tenant's contact_email. Callers don't need to fetch the tenant
 * profile themselves.
 *
 * Explicit `from` / `replyTo` still win when provided, useful for system
 * emails (platform admin notices, auth) where the platform is the sender.
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
  to: string | string[];
  subject: string;
  html: string;
  /** Optional override for the plain-text alternative. When omitted, one
   *  is auto-generated from `html`. Modern spam filters downweight
   *  HTML-only emails — always shipping both parts is a free
   *  deliverability win. */
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
  let resolvedFrom = from;
  let resolvedReplyTo = replyTo;
  let usedTenantHeader = false;

  if (tenantId && !from) {
    try {
      const tenantHeader = await getTenantFromHeader(tenantId);
      resolvedFrom = tenantHeader.from;
      resolvedReplyTo = replyTo ?? tenantHeader.replyTo;
      usedTenantHeader = true;
    } catch (e) {
      // Fall back to platform default if tenant lookup fails — don't block the send.
      const _err = e instanceof Error ? e.message : String(e);
      void _err;
    }
  }

  // Pick the message stream based on intent. Defaults to transactional.
  const isMarketing = MARKETING_CASL_CATEGORIES.has(caslCategory);
  const messageStream = usedTenantHeader
    ? STREAM_TENANTS
    : isMarketing
      ? STREAM_MARKETING
      : STREAM_TRANSACTIONAL;

  // If still no FROM, pick the per-stream default. Marketing → marketing
  // subdomain. Everything else → transactional subdomain.
  if (!resolvedFrom) {
    resolvedFrom = isMarketing ? FROM_EMAIL_MARKETING : FROM_EMAIL;
  }

  // Tracking flags per stream. Transactional stays clean (auth-adjacent
  // mail gets pre-clicked by Gmail's link scanner). Marketing + tenant
  // streams get full engagement tracking.
  const trackOpens = messageStream !== STREAM_TRANSACTIONAL;
  const trackLinks =
    messageStream !== STREAM_TRANSACTIONAL
      ? Models.LinkTrackingOptions.HtmlAndText
      : Models.LinkTrackingOptions.None;

  // Postmark accepts comma-separated string or single address. We
  // normalize so the audit log row stores a comma-joined string for
  // searchability.
  const toArray = Array.isArray(to) ? to : [to];
  const toForLog = toArray.join(', ');
  const toForApi = toArray.join(', ');

  // 1. Pre-log as queued so we have an audit row even if the send throws.
  const supabase = createAdminClient();
  const { data: row, error: insertErr } = await supabase
    .from('email_send_log')
    .insert({
      tenant_id: tenantId ?? null,
      direction: 'outbound',
      to_address: toForLog,
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

  // QA / demo tenants: keep the audit row (so QA can inspect what would
  // have gone out) but never hand it to Postmark. Test invoices and
  // estimates must not reach real inboxes. See src/lib/tenants/demo.ts.
  if (await isDemoTenant(tenantId)) {
    await supabase.from('email_send_log').update({ status: 'suppressed_demo' }).eq('id', row.id);
    return { ok: true, id: `demo-suppressed-${row.id}` };
  }

  // 2. Fire the Postmark API call.
  try {
    const postmark = getPostmark();
    const resolvedText = text ?? htmlToPlainText(html);

    const headerEntries = headers ? Object.entries(headers) : [];

    const response = await postmark.sendEmail({
      From: resolvedFrom,
      To: toForApi,
      Subject: subject,
      HtmlBody: html,
      TextBody: resolvedText || undefined,
      ReplyTo: resolvedReplyTo,
      MessageStream: messageStream,
      TrackOpens: trackOpens,
      TrackLinks: trackLinks,
      Headers: headerEntries.length
        ? headerEntries.map(([Name, Value]) => ({ Name, Value }))
        : undefined,
      Attachments: attachments?.map((a) => ({
        Name: a.filename,
        Content: a.content.toString('base64'),
        ContentType: a.contentType ?? 'application/octet-stream',
        ContentID: null,
      })),
    });

    const providerId = response.MessageID;
    await supabase
      .from('email_send_log')
      .update({
        provider_id: providerId,
        status: 'sent',
        sent_at: new Date().toISOString(),
      })
      .eq('id', row.id);

    return { ok: true, id: providerId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown email error';
    await supabase
      .from('email_send_log')
      .update({ status: 'failed', error_message: msg })
      .eq('id', row.id);
    return { ok: false, error: msg };
  }
}
