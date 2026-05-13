/**
 * POST /api/ar/webhooks/postmark
 *
 * Postmark webhook receiver. Handles delivery + engagement + complaint
 * events from all three outbound streams (transactional, marketing,
 * tenants). Updates the matching ar_send_log row by provider_id (which
 * is Postmark's MessageID).
 *
 * Auth: query-param token matched against POSTMARK_OUTBOUND_WEBHOOK_TOKEN.
 * Each Postmark stream's webhook URL is configured as
 *   https://app.heyhenry.io/api/ar/webhooks/postmark?token=<uuid>
 *
 * Postmark event types handled (RecordType field):
 *   Delivery        → status=delivered
 *   Bounce          → status=bounced, bounced_at, suppress
 *   SpamComplaint   → status=complained, complained_at, suppress, CASL flip
 *   Open            → opened_at (first-open only)
 *   Click           → clicked_at (first-click only)
 *   SubscriptionChange → no-op for now (future: sync unsubscribes)
 */

import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { arSendLog, arSuppressionList } from '@/lib/db/schema/ar';
import { customers } from '@/lib/db/schema/customers';
import { claimWebhookEvent } from '@/lib/webhooks/idempotency';

export const dynamic = 'force-dynamic';

type PostmarkEvent = {
  RecordType: string;
  MessageID?: string;
  Recipient?: string;
  Email?: string;
  Type?: string;
  [key: string]: unknown;
};

export async function POST(request: Request) {
  const expected = process.env.POSTMARK_OUTBOUND_WEBHOOK_TOKEN;
  if (!expected) {
    return Response.json({ error: 'Webhook not configured' }, { status: 500 });
  }
  const token = new URL(request.url).searchParams.get('token');
  if (!token || token !== expected) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let event: PostmarkEvent;
  try {
    event = (await request.json()) as PostmarkEvent;
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const messageId = event.MessageID;
  if (!messageId) return Response.json({ ok: true, ignored: 'no_message_id' });

  // Idempotency: same MessageID can emit different RecordTypes (Delivery
  // then Open then Click). Dedup on the pair, so a retry of the SAME event
  // is short-circuited but the natural event stream still flows.
  const claim = await claimWebhookEvent(
    'postmark:ar',
    `${messageId}:${event.RecordType}`,
    event as unknown as Record<string, unknown>,
  );
  if (claim.alreadyProcessed) {
    return Response.json({ ok: true, deduplicated: true });
  }

  const db = getDb();
  const now = new Date();
  // Postmark uses different field names per event type. Recipient is set
  // for Delivery/Open/Click/SubscriptionChange. Email is set for
  // Bounce/SpamComplaint. Normalize.
  const toAddress = (event.Recipient || event.Email || '').toString().toLowerCase() || null;

  switch (event.RecordType) {
    case 'Delivery':
      await db
        .update(arSendLog)
        .set({ status: 'delivered' })
        .where(and(eq(arSendLog.providerId, messageId), eq(arSendLog.channel, 'email')));
      break;

    case 'Open':
      await db
        .update(arSendLog)
        .set({ openedAt: now })
        .where(
          and(
            eq(arSendLog.providerId, messageId),
            eq(arSendLog.channel, 'email'),
            sql`${arSendLog.openedAt} IS NULL`,
          ),
        );
      break;

    case 'Click':
      await db
        .update(arSendLog)
        .set({ clickedAt: now })
        .where(
          and(
            eq(arSendLog.providerId, messageId),
            eq(arSendLog.channel, 'email'),
            sql`${arSendLog.clickedAt} IS NULL`,
          ),
        );
      break;

    case 'Bounce':
      await db
        .update(arSendLog)
        .set({ status: 'bounced', bouncedAt: now })
        .where(and(eq(arSendLog.providerId, messageId), eq(arSendLog.channel, 'email')));
      if (toAddress) {
        await db
          .insert(arSuppressionList)
          .values({
            address: toAddress,
            channel: 'email',
            reason: 'bounce',
            notes: (event.Type as string | undefined) ?? null,
          })
          .onConflictDoNothing();
      }
      break;

    case 'SpamComplaint':
      await db
        .update(arSendLog)
        .set({ status: 'complained', complainedAt: now })
        .where(and(eq(arSendLog.providerId, messageId), eq(arSendLog.channel, 'email')));
      if (toAddress) {
        await db
          .insert(arSuppressionList)
          .values({
            address: toAddress,
            channel: 'email',
            reason: 'complaint',
          })
          .onConflictDoNothing();
        // CASL: complaint is a legal stop signal. Flip platform-wide.
        await db
          .update(customers)
          .set({
            doNotAutoMessage: true,
            doNotAutoMessageAt: now,
            doNotAutoMessageSource: 'email_complaint',
          })
          .where(
            and(
              sql`lower(${customers.email}) = ${toAddress}`,
              eq(customers.doNotAutoMessage, false),
            ),
          );
      }
      break;

    default:
      // SubscriptionChange and any future types — no-op.
      break;
  }

  return Response.json({ ok: true });
}
