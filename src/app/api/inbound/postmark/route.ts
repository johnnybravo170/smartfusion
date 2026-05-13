/**
 * Postmark inbound email webhook.
 *
 * Single shared inbox `henry@heyhenry.io`. Tenant resolved from the From
 * header against tenant_members.role IN ('owner', 'admin'). Unknown or
 * ambiguous senders get a polite bounce; we still persist a row with
 * status='bounced' for abuse visibility.
 *
 * Recognised senders → row in 'pending' status, processor runs inline,
 * row ends in 'needs_review' (or 'rejected' for classification='other').
 * Postmark tolerates up to 30s for the response.
 */

import { NextResponse } from 'next/server';
import { sendUnknownSenderBounce } from '@/lib/inbound-email/bounce';
import {
  type CustomerMessageHandlerInput,
  handleCustomerInboundMessage,
} from '@/lib/inbound-email/customer-message-handler';
import { processInboundEmail } from '@/lib/inbound-email/processor';
import { resolveSenderToTenant } from '@/lib/inbound-email/sender-resolver';
import { createAdminClient } from '@/lib/supabase/admin';
import { claimWebhookEvent } from '@/lib/webhooks/idempotency';

export const runtime = 'nodejs';
export const maxDuration = 60;

type PostmarkAttachment = {
  Name: string;
  ContentType: string;
  Content: string;
  ContentLength: number;
};

type PostmarkHeader = { Name: string; Value: string };

type PostmarkInbound = {
  MessageID: string;
  From: string;
  FromName?: string;
  To: string;
  OriginalRecipient?: string;
  Subject?: string;
  TextBody?: string;
  HtmlBody?: string;
  Headers?: PostmarkHeader[];
  Attachments?: PostmarkAttachment[];
};

function verifyToken(url: string): boolean {
  const expected = process.env.POSTMARK_INBOUND_TOKEN;
  if (!expected) return false;
  return new URL(url).searchParams.get('token') === expected;
}

export async function POST(request: Request) {
  if (!verifyToken(request.url)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let payload: PostmarkInbound;
  try {
    payload = (await request.json()) as PostmarkInbound;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Idempotency: Postmark may retry on 5xx. MessageID is unique per
  // inbound email; claim it before any side effects.
  if (payload.MessageID) {
    const claim = await claimWebhookEvent('postmark:inbound', payload.MessageID, payload);
    if (claim.alreadyProcessed) {
      return NextResponse.json({ ok: true, deduplicated: true });
    }
  }

  const tenantId = await resolveSenderToTenant(payload.From);
  const admin = createAdminClient();

  // TEMP DEBUG — remove once happy-path smoke test confirmed
  console.log(
    '[inbound-debug]',
    JSON.stringify({
      rawFrom: payload.From,
      resolvedTenantId: tenantId,
      subject: payload.Subject,
    }),
  );

  // Sender isn't a tenant member — try the customer-reply branch
  // (Phase 2 of PROJECT_MESSAGING_PLAN.md). The handler resolves to a
  // (tenant, project) tuple via In-Reply-To → footer token → recency,
  // and bounces on ambiguity rather than guessing.
  if (!tenantId) {
    const handlerInput: CustomerMessageHandlerInput = {
      postmarkMessageId: payload.MessageID,
      fromHeader: payload.From,
      fromName: payload.FromName ?? null,
      subject: payload.Subject ?? null,
      bodyText: payload.TextBody ?? null,
      bodyHtml: payload.HtmlBody ?? null,
      headers: payload.Headers ?? [],
    };
    const customerResult = await handleCustomerInboundMessage(handlerInput);

    if (customerResult.ok) {
      return NextResponse.json({
        ok: true,
        kind: 'customer_message',
        id: customerResult.messageId,
        projectId: customerResult.projectId,
      });
    }

    if (customerResult.reason === 'loop_guard') {
      // Drop autoresponders silently — no row, no bounce. The customer
      // didn't actually send anything; their server did.
      return NextResponse.json({ ok: true, dropped: 'autoresponder' });
    }

    // Unresolved (unknown sender or ambiguous tenant match) — bounce,
    // persist a row for abuse / ops visibility, return 200.
    try {
      await sendUnknownSenderBounce({
        to: payload.From,
        originalSubject: payload.Subject ?? '(no subject)',
      });
    } catch (err) {
      console.error('[inbound-email] bounce send failed', err);
    }

    await admin.from('inbound_emails').insert({
      tenant_id: null,
      postmark_message_id: payload.MessageID,
      to_address: payload.OriginalRecipient || payload.To,
      from_address: payload.From,
      from_name: payload.FromName ?? null,
      subject: payload.Subject ?? null,
      body_text: payload.TextBody ?? null,
      body_html: payload.HtmlBody ?? null,
      attachments: (payload.Attachments ?? []).map((a) => ({
        filename: a.Name,
        contentType: a.ContentType,
        size: a.ContentLength,
      })),
      raw_payload: null,
      status: 'bounced',
      error_message: 'Sender not on a tenant_member or matched customer for any project',
    });

    return NextResponse.json({ ok: true, bounced: true });
  }

  const attachments = (payload.Attachments ?? []).map((a) => ({
    filename: a.Name,
    contentType: a.ContentType,
    base64: a.Content,
    size: a.ContentLength,
  }));

  const { data: inserted, error } = await admin
    .from('inbound_emails')
    .insert({
      tenant_id: tenantId,
      postmark_message_id: payload.MessageID,
      to_address: payload.OriginalRecipient || payload.To,
      from_address: payload.From,
      from_name: payload.FromName ?? null,
      subject: payload.Subject ?? null,
      body_text: payload.TextBody ?? null,
      body_html: payload.HtmlBody ?? null,
      attachments,
      raw_payload: payload as unknown as Record<string, unknown>,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error || !inserted) {
    console.error('[inbound-email] persist failed', error);
    return NextResponse.json({ error: error?.message ?? 'Insert failed' }, { status: 500 });
  }

  // Await inline — Vercel serverless terminates fire-and-forget work the
  // moment we return. Postmark tolerates up to 30s.
  try {
    await processInboundEmail(inserted.id as string);
  } catch (err) {
    console.error('[inbound-email] processing failed', inserted.id, err);
  }

  return NextResponse.json({ ok: true, id: inserted.id });
}
