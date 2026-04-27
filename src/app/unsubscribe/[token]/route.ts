/**
 * GET /unsubscribe/:token   → confirmation page (HTML)
 * POST /unsubscribe/:token  → perform unsubscribe
 *
 * One-click unsubscribe. The GET renders a tiny confirm page; the POST flips
 * the subscription flag and records the suppression. We also support the
 * RFC 8058 List-Unsubscribe=One-Click contract: a POST with
 * `List-Unsubscribe=One-Click` in the body unsubscribes immediately without a
 * confirmation UI, which Gmail/Yahoo require for bulk senders.
 */

import { and, eq, sql } from 'drizzle-orm';
import { verifyUnsubToken } from '@/lib/ar/unsub-token';
import { getDb } from '@/lib/db/client';
import { arContacts, arEnrollments, arSuppressionList } from '@/lib/db/schema/ar';
import { customers } from '@/lib/db/schema/customers';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const payload = verifyUnsubToken(token);
  if (!payload) {
    return htmlResponse(pageInvalid(), 400);
  }
  return htmlResponse(pageConfirm(token));
}

export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const payload = verifyUnsubToken(token);
  if (!payload) {
    return htmlResponse(pageInvalid(), 400);
  }

  const db = getDb();
  const [contact] = await db.select().from(arContacts).where(eq(arContacts.id, payload.c));
  if (!contact) {
    return htmlResponse(pageDone('This contact no longer exists.'));
  }

  const now = new Date();

  if (payload.s === 'all') {
    // Global unsubscribe: flip flags + add to suppression list.
    await db
      .update(arContacts)
      .set({ emailSubscribed: false, unsubscribedAt: now })
      .where(eq(arContacts.id, contact.id));

    if (contact.email) {
      await db
        .insert(arSuppressionList)
        .values({
          address: contact.email.toLowerCase(),
          channel: 'email',
          reason: 'unsubscribe',
        })
        .onConflictDoNothing();
      // CASL: also flip the kill switch on every matching customer row
      // (across tenants) so future automated messages from any contractor
      // are blocked.
      await db
        .update(customers)
        .set({
          doNotAutoMessage: true,
          doNotAutoMessageAt: now,
          doNotAutoMessageSource: 'unsubscribe_link',
        })
        .where(
          and(
            sql`lower(${customers.email}) = ${contact.email.toLowerCase()}`,
            eq(customers.doNotAutoMessage, false),
          ),
        );
    }
  } else {
    // Per-sequence unsubscribe: cancel only matching active enrollments.
    await db
      .update(arEnrollments)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(arEnrollments.contactId, contact.id),
          eq(arEnrollments.sequenceId, payload.s),
          eq(arEnrollments.status, 'active'),
        ),
      );
  }

  return htmlResponse(pageDone("You've been unsubscribed. You won't receive further emails."));
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function shell(inner: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribe · Hey Henry</title>
<style>
  body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111; background: #fafafa; margin: 0; padding: 48px 16px; }
  .card { max-width: 480px; margin: 0 auto; background: #fff; border: 1px solid #e5e5e5; border-radius: 12px; padding: 32px; }
  h1 { margin: 0 0 12px; font-size: 20px; }
  p { margin: 0 0 16px; color: #444; }
  button { font: inherit; padding: 10px 16px; background: #111; color: #fff; border: 0; border-radius: 8px; cursor: pointer; }
  button:hover { opacity: .9; }
</style></head><body><div class="card">${inner}</div></body></html>`;
}

function pageConfirm(token: string): string {
  return shell(`
    <h1>Unsubscribe?</h1>
    <p>Confirm to stop receiving emails from Hey Henry.</p>
    <form method="post" action="/unsubscribe/${encodeURIComponent(token)}">
      <button type="submit">Yes, unsubscribe me</button>
    </form>
  `);
}

function pageDone(msg: string): string {
  return shell(`<h1>Done</h1><p>${escapeHtml(msg)}</p>`);
}

function pageInvalid(): string {
  return shell(
    `<h1>Invalid link</h1><p>This unsubscribe link is not valid or has been tampered with.</p>`,
  );
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
