/**
 * POST /api/ar/webhooks/resend
 *
 * Resend webhook receiver. Handles engagement + delivery events and updates
 * the matching ar_send_log row by provider_id.
 *
 * Events handled:
 *   email.delivered         → status=delivered
 *   email.opened            → opened_at
 *   email.clicked           → clicked_at
 *   email.bounced           → status=bounced, bounced_at, add to suppression
 *   email.complained        → status=complained, complained_at, add to suppression
 *   email.delivery_delayed  → no-op (informational)
 *   email.sent              → already recorded by the sender; no-op
 *
 * Bounces and complaints auto-suppress the address so sequences can't keep
 * hammering a dead inbox.
 */

import { and, eq, sql } from 'drizzle-orm';
import { verifySvixSignature } from '@/lib/ar/webhook-verify';
import { getDb } from '@/lib/db/client';
import { arSendLog, arSuppressionList } from '@/lib/db/schema/ar';
import { customers } from '@/lib/db/schema/customers';

export const dynamic = 'force-dynamic';

type ResendEvent = {
  type: string;
  created_at?: string;
  data: {
    email_id?: string;
    to?: string | string[];
    bounce?: { type?: string };
    [key: string]: unknown;
  };
};

export async function POST(request: Request) {
  const rawBody = await request.text();
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  const verify = verifySvixSignature({
    id: request.headers.get('svix-id'),
    timestamp: request.headers.get('svix-timestamp'),
    signatureHeader: request.headers.get('svix-signature'),
    rawBody,
    secret,
  });
  if (!verify.ok) {
    return Response.json({ error: verify.reason }, { status: 401 });
  }

  let event: ResendEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const emailId = event.data?.email_id;
  if (!emailId) return Response.json({ ok: true, ignored: 'no_email_id' });

  const db = getDb();
  const now = new Date();

  const toAddress = Array.isArray(event.data.to) ? event.data.to[0] : event.data.to;

  switch (event.type) {
    case 'email.delivered':
      await db
        .update(arSendLog)
        .set({ status: 'delivered' })
        .where(and(eq(arSendLog.providerId, emailId), eq(arSendLog.channel, 'email')));
      break;

    case 'email.opened':
      // Only set on first open.
      await db
        .update(arSendLog)
        .set({ openedAt: now })
        .where(
          and(
            eq(arSendLog.providerId, emailId),
            eq(arSendLog.channel, 'email'),
            sql`${arSendLog.openedAt} IS NULL`,
          ),
        );
      break;

    case 'email.clicked':
      await db
        .update(arSendLog)
        .set({ clickedAt: now })
        .where(
          and(
            eq(arSendLog.providerId, emailId),
            eq(arSendLog.channel, 'email'),
            sql`${arSendLog.clickedAt} IS NULL`,
          ),
        );
      break;

    case 'email.bounced':
      await db
        .update(arSendLog)
        .set({ status: 'bounced', bouncedAt: now })
        .where(and(eq(arSendLog.providerId, emailId), eq(arSendLog.channel, 'email')));
      if (toAddress) {
        await db
          .insert(arSuppressionList)
          .values({
            address: toAddress.toLowerCase(),
            channel: 'email',
            reason: 'bounce',
            notes: event.data.bounce?.type ?? null,
          })
          .onConflictDoNothing();
      }
      break;

    case 'email.complained':
      await db
        .update(arSendLog)
        .set({ status: 'complained', complainedAt: now })
        .where(and(eq(arSendLog.providerId, emailId), eq(arSendLog.channel, 'email')));
      if (toAddress) {
        await db
          .insert(arSuppressionList)
          .values({
            address: toAddress.toLowerCase(),
            channel: 'email',
            reason: 'complaint',
          })
          .onConflictDoNothing();
        // CASL: complaint = legal stop signal. Flip platform-wide.
        await db
          .update(customers)
          .set({
            doNotAutoMessage: true,
            doNotAutoMessageAt: now,
            doNotAutoMessageSource: 'email_complaint',
          })
          .where(
            and(
              sql`lower(${customers.email}) = ${toAddress.toLowerCase()}`,
              eq(customers.doNotAutoMessage, false),
            ),
          );
      }
      break;

    default:
      // email.sent, email.delivery_delayed, etc. — no-op.
      break;
  }

  return Response.json({ ok: true });
}
