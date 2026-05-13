/**
 * Webhook idempotency: claim an event before processing.
 *
 * Pattern (call near the top of every webhook handler, AFTER signature
 * verification but BEFORE any side effects):
 *
 *   const claim = await claimWebhookEvent('stripe', event.id, event);
 *   if (claim.alreadyProcessed) {
 *     return new Response('ok', { status: 200 });
 *   }
 *   // ...do side-effects...
 *
 * The first claim for a (provider, event_id) pair inserts a row; any
 * later claim sees the duplicate-key violation and short-circuits. We
 * never delete rows in the hot path — a separate retention job (TODO)
 * trims rows older than 90 days.
 *
 * Each provider's `event_id` is whatever makes a webhook delivery
 * unique. See the migration comment for the convention per provider.
 */

import { createAdminClient } from '@/lib/supabase/admin';

export type WebhookEventClaim = { alreadyProcessed: false } | { alreadyProcessed: true };

export async function claimWebhookEvent(
  provider: string,
  eventId: string,
  body: unknown,
): Promise<WebhookEventClaim> {
  if (!provider || !eventId) {
    // Safer to process than to silently drop — caller decides what to do
    // with an event that has no id. Most providers always include one;
    // the few that don't can pass a hash of the raw body.
    return { alreadyProcessed: false };
  }

  const admin = createAdminClient();
  const { error } = await admin.from('webhook_events').insert({
    provider,
    event_id: eventId,
    body: body == null ? null : (body as Record<string, unknown>),
  });

  if (!error) return { alreadyProcessed: false };

  // 23505 = unique_violation. Anything else (network, RLS) we treat as
  // "process anyway" — losing a webhook is worse than processing twice
  // for the kinds of side-effects we have today (which are themselves
  // largely idempotent: UPDATE … WHERE id = ?).
  if (error.code === '23505') return { alreadyProcessed: true };

  console.warn(
    `[webhook-idempotency] failed to claim ${provider}:${eventId} — processing anyway: ${error.message}`,
  );
  return { alreadyProcessed: false };
}
