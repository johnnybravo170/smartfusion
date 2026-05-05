/**
 * Alert hook — emails the operator when a provider call fails with a
 * rate-limit / quota / overload kind. These are the failure modes that
 * need *manual* action (top up credits, raise budget cap, switch a
 * route) rather than letting the fallback chain handle it.
 *
 * Debounce: an `ai_alerts` row per (provider, kind) holds the last-sent
 * timestamp. The atomic claim runs as a single statement so two parallel
 * attempts can't both fire an email. Window defaults to 15 minutes; can
 * be tuned with AI_ALERT_DEBOUNCE_MINUTES.
 *
 * Recipient: AI_ALERT_EMAIL (env). If unset, the hook no-ops — explicit
 * opt-in, no surprise emails when the env isn't configured (e.g. in
 * preview deploys or local dev).
 */

import { sendEmail } from '@/lib/email/send';
import { createAdminClient } from '@/lib/supabase/admin';
import type { AiErrorKind } from './errors';
import type { RouterAttemptEvent, RouterHooks } from './router-types';

const ALERT_KINDS: ReadonlySet<AiErrorKind> = new Set(['rate_limit', 'quota', 'overload']);

const DEFAULT_DEBOUNCE_MINUTES = 15;

export function createAlertHook(): RouterHooks {
  return {
    onAttempt: (event: RouterAttemptEvent) => {
      if (event.outcome !== 'error') return;
      if (!event.error_kind || !ALERT_KINDS.has(event.error_kind)) return;
      // Fire-and-forget — never block the user's call on alerting.
      void maybeAlert(event).catch(() => {});
    },
  };
}

async function maybeAlert(event: RouterAttemptEvent): Promise<void> {
  const recipient = process.env.AI_ALERT_EMAIL?.trim();
  if (!recipient) return;

  const debounceMinutes = parseDebounceMinutes();
  const claimed = await claimAlertSlot(
    event.provider,
    event.error_kind ?? 'unknown',
    debounceMinutes,
  );
  if (!claimed) return; // Someone else already alerted within the window.

  const subject = `[HeyHenry AI] ${event.error_kind} on ${event.provider}`;
  const html = `
    <p>An AI provider call failed with a kind that needs manual attention.</p>
    <ul>
      <li><strong>Provider:</strong> ${escapeHtml(event.provider)}</li>
      <li><strong>Kind:</strong> ${escapeHtml(event.error_kind ?? 'unknown')}</li>
      <li><strong>Task:</strong> ${escapeHtml(event.task)}</li>
      <li><strong>Model:</strong> ${escapeHtml(event.model)}</li>
      <li><strong>Tenant:</strong> ${escapeHtml(event.tenant_id ?? '(none)')}</li>
      <li><strong>Time:</strong> ${new Date().toISOString()}</li>
    </ul>
    <p>Suggested action by kind:</p>
    <ul>
      <li><em>quota</em> — top up provider credits, or raise the project's monthly budget cap.</li>
      <li><em>rate_limit</em> — climb the provider usage tier, or shift traffic to a fallback in routing.ts.</li>
      <li><em>overload</em> — provider-side outage; usually resolves on its own. Watch the status page.</li>
    </ul>
    <p>Further alerts of this kind are debounced for ${debounceMinutes} minutes.</p>
  `;

  await sendEmail({
    to: recipient,
    subject,
    html,
    caslCategory: 'transactional',
    caslEvidence: {
      reason: 'ai_provider_alert',
      provider: event.provider,
      kind: event.error_kind,
      task: event.task,
    },
  });
}

/**
 * Atomically claim the alert slot for (provider, kind). Returns true iff
 * this caller is the one who got the slot — i.e. either the row didn't
 * exist, or the previous `last_sent_at` was older than the debounce
 * window. Implemented as a single round trip via INSERT...ON CONFLICT
 * with a WHERE-clause on the DO UPDATE, so concurrent attempts don't
 * double-fire.
 */
async function claimAlertSlot(
  provider: string,
  kind: string,
  debounceMinutes: number,
): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('ai_alerts_claim_slot', {
    p_provider: provider,
    p_kind: kind,
    p_debounce_minutes: debounceMinutes,
  });
  if (error) {
    // RPC not available or failed — fall back to a non-atomic check
    // rather than spamming. Read-then-write is good enough at our
    // current scale (single-digit alerts/hour worst case).
    return claimViaReadWrite(provider, kind, debounceMinutes);
  }
  return Boolean(data);
}

async function claimViaReadWrite(
  provider: string,
  kind: string,
  debounceMinutes: number,
): Promise<boolean> {
  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - debounceMinutes * 60_000).toISOString();
  const { data: existing } = await admin
    .from('ai_alerts')
    .select('last_sent_at')
    .eq('provider', provider)
    .eq('kind', kind)
    .maybeSingle();
  if (existing?.last_sent_at && existing.last_sent_at > cutoff) return false;
  const { error: upsertErr } = await admin
    .from('ai_alerts')
    .upsert({ provider, kind, last_sent_at: new Date().toISOString() });
  return !upsertErr;
}

function parseDebounceMinutes(): number {
  const raw = process.env.AI_ALERT_DEBOUNCE_MINUTES;
  if (!raw) return DEFAULT_DEBOUNCE_MINUTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DEBOUNCE_MINUTES;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
