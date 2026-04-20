/**
 * Postmark inbound email webhook.
 *
 * Flow:
 *   1. Verify HTTP Basic Auth (Postmark → our endpoint).
 *   2. Parse the To address to resolve tenant by slug.
 *   3. Persist raw email row.
 *   4. Fire-and-forget classify + auto-action.
 *
 * Postmark retries non-2xx responses for 24h, so we return 200 as soon as
 * the row is persisted; classification errors are recorded on the row
 * rather than surfaced back to Postmark.
 */

import { NextResponse } from 'next/server';
import { processInboundEmail } from '@/lib/inbound-email/processor';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const maxDuration = 60;

type PostmarkAttachment = {
  Name: string;
  ContentType: string;
  Content: string;
  ContentLength: number;
};

type PostmarkInbound = {
  MessageID: string;
  From: string;
  FromName?: string;
  To: string;
  OriginalRecipient?: string;
  Subject?: string;
  TextBody?: string;
  HtmlBody?: string;
  Attachments?: PostmarkAttachment[];
};

function verifyToken(url: string): boolean {
  const expected = process.env.POSTMARK_INBOUND_TOKEN;
  if (!expected) return false;
  const token = new URL(url).searchParams.get('token');
  return token === expected;
}

/** Extract the tenant slug from a `slug@quotes.heyhenry.io` address. */
function extractSlug(address: string): string | null {
  const match = address.match(/^([^@+]+)(?:\+[^@]*)?@/);
  return match ? match[1].toLowerCase() : null;
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

  const toAddress = payload.OriginalRecipient || payload.To;
  const slug = extractSlug(toAddress);

  const admin = createAdminClient();

  let tenantId: string | null = null;
  if (slug) {
    const { data: tenant } = await admin
      .from('tenants')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();
    tenantId = (tenant?.id as string) ?? null;
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
      to_address: toAddress,
      from_address: payload.From,
      from_name: payload.FromName ?? null,
      subject: payload.Subject ?? null,
      body_text: payload.TextBody ?? null,
      body_html: payload.HtmlBody ?? null,
      attachments,
      raw_payload: payload as unknown as Record<string, unknown>,
      status: tenantId ? 'pending' : 'error',
      error_message: tenantId ? null : `No tenant matches slug "${slug}"`,
    })
    .select('id')
    .single();

  if (error || !inserted) {
    console.error('[inbound-email] failed to persist', error);
    return NextResponse.json({ error: error?.message ?? 'Insert failed' }, { status: 500 });
  }

  if (tenantId) {
    // Don't await — return 200 fast; classifier failures are recorded on the row.
    processInboundEmail(inserted.id as string).catch((err) => {
      console.error('[inbound-email] processing failed', inserted.id, err);
    });
  }

  return NextResponse.json({ ok: true, id: inserted.id });
}
