/**
 * AR policy engine — runs at the moment of dispatch (not at enrollment time).
 *
 * The cron worker calls `checkSendPolicy()` before every send. Outcome is
 * either:
 *   - { send: true }                    → dispatch now
 *   - { send: false, defer, retryAt }   → push next_run_at to retryAt
 *   - { send: false, skip, reason }     → mark enrollment errored or skip step
 *
 * Rules (in order):
 *   1. Address must exist on the contact for the channel
 *   2. Contact must be subscribed on the channel (email_subscribed/sms_subscribed)
 *   3. Address must not be on ar_suppression_list
 *   4. For SMS: address must not be opted out in sms_preferences
 *   5. Must be inside the send window (sequence override, else global defaults)
 *   6. Frequency cap: no more than 1 email per contact in any 4-hour window
 *
 * Defaults (platform-wide, overridable per sequence):
 *   Email quiet hours: 21:00 – 08:00 contact-local
 *   Email allowed days: Sun–Sat (all)
 *   SMS quiet hours: 21:00 – 10:00 contact-local
 *   SMS allowed days: Mon–Fri (stricter per TCPA/CRTC)
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import type { getDb } from '@/lib/db/client';
import { arContacts, arSendLog, arSuppressionList } from '@/lib/db/schema/ar';

type Db = ReturnType<typeof getDb>;

export type Channel = 'email' | 'sms';

export type SendWindow = {
  quietStart: number | null; // hour 0-23
  quietEnd: number | null;
  daysOfWeek: number[] | null; // 0=Sun..6=Sat
};

export type PolicyDecision =
  | { send: true }
  | { send: false; defer: true; retryAt: Date; reason: string }
  | { send: false; defer: false; reason: string };

const DEFAULT_EMAIL_WINDOW: SendWindow = {
  quietStart: 21,
  quietEnd: 8,
  daysOfWeek: null, // all days
};

const DEFAULT_SMS_WINDOW: SendWindow = {
  quietStart: 21,
  quietEnd: 10,
  daysOfWeek: [1, 2, 3, 4, 5], // Mon–Fri
};

const FREQUENCY_CAP_EMAIL_HOURS = 4;

export function defaultWindow(channel: Channel): SendWindow {
  return channel === 'email' ? DEFAULT_EMAIL_WINDOW : DEFAULT_SMS_WINDOW;
}

/**
 * Given a moment in the contact's local timezone, is it inside the allowed
 * send window? Returns either { ok: true } or { ok: false, retryAt }.
 */
export function checkWindow(
  now: Date,
  window: SendWindow,
  timezone: string,
): { ok: true } | { ok: false; retryAt: Date } {
  const local = toLocalParts(now, timezone);

  const dayOk = window.daysOfWeek === null || window.daysOfWeek.includes(local.dayOfWeek);
  const hourOk = hourInsideWindow(local.hour, window.quietStart, window.quietEnd);

  if (dayOk && hourOk) return { ok: true };

  return { ok: false, retryAt: nextOpenSlot(now, window, timezone) };
}

function hourInsideWindow(
  hour: number,
  quietStart: number | null,
  quietEnd: number | null,
): boolean {
  if (quietStart === null || quietEnd === null) return true;
  // Quiet window may cross midnight (e.g. 21 → 8). Outside quiet = eligible.
  if (quietStart < quietEnd) {
    return hour < quietStart || hour >= quietEnd;
  }
  return hour >= quietEnd && hour < quietStart;
}

function toLocalParts(date: Date, timezone: string): { hour: number; dayOfWeek: number } {
  // Intl.DateTimeFormat gives us tz-correct hour and weekday.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
    weekday: 'short',
  });
  const parts = fmt.formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const weekdayStr = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hour, dayOfWeek: dayMap[weekdayStr] ?? 0 };
}

/**
 * Walk forward in 30-minute increments until we land in an allowed slot.
 * Capped at 8 days so we never loop forever on a misconfigured window.
 */
function nextOpenSlot(from: Date, window: SendWindow, timezone: string): Date {
  const step = 30 * 60 * 1000;
  const cap = 8 * 24 * 60; // minutes
  let cursor = new Date(from.getTime() + step);
  for (let i = 0; i < cap / 30; i++) {
    const local = toLocalParts(cursor, timezone);
    const dayOk = window.daysOfWeek === null || window.daysOfWeek.includes(local.dayOfWeek);
    const hourOk = hourInsideWindow(local.hour, window.quietStart, window.quietEnd);
    if (dayOk && hourOk) return cursor;
    cursor = new Date(cursor.getTime() + step);
  }
  // Fallback: return 24h out; caller will retry again.
  return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * Full per-send check. Pass `window` pre-merged (sequence override or default).
 */
export async function checkSendPolicy(
  db: Db,
  params: {
    contactId: string;
    channel: Channel;
    window: SendWindow;
    now?: Date;
  },
): Promise<PolicyDecision> {
  const now = params.now ?? new Date();

  const [contact] = await db
    .select()
    .from(arContacts)
    .where(eq(arContacts.id, params.contactId))
    .limit(1);
  if (!contact) return { send: false, defer: false, reason: 'contact_not_found' };

  const address = params.channel === 'email' ? contact.email : contact.phone;
  if (!address) return { send: false, defer: false, reason: 'no_address' };

  // Channel-specific subscription.
  if (params.channel === 'email' && !contact.emailSubscribed) {
    return { send: false, defer: false, reason: 'email_unsubscribed' };
  }
  if (params.channel === 'sms' && !contact.smsSubscribed) {
    return { send: false, defer: false, reason: 'sms_unsubscribed' };
  }
  if (contact.unsubscribedAt) {
    return { send: false, defer: false, reason: 'global_unsubscribed' };
  }

  // Global suppression list.
  const normalized = params.channel === 'email' ? address.toLowerCase() : address;
  const [suppression] = await db
    .select()
    .from(arSuppressionList)
    .where(
      and(eq(arSuppressionList.address, normalized), eq(arSuppressionList.channel, params.channel)),
    )
    .limit(1);
  if (suppression) {
    return { send: false, defer: false, reason: `suppressed_${suppression.reason}` };
  }

  // SMS: also honor global sms_preferences opt-out.
  if (params.channel === 'sms') {
    const rows = await db.execute(
      sql`SELECT opted_out FROM public.sms_preferences WHERE phone_number = ${address} LIMIT 1`,
    );
    // `rows` shape is driver-specific; postgres-js returns an array of row objects.
    const opted = (rows as unknown as Array<{ opted_out: boolean }>)[0]?.opted_out;
    if (opted) return { send: false, defer: false, reason: 'sms_preference_opted_out' };
  }

  // Customer-level kill switch (CASL). Once a recipient has been flagged
  // do_not_auto_message — via unsubscribe, STOP, complaint, or manual — no
  // automated send goes out, regardless of suppression-list state.
  // Match on email (lowercased) or phone (E.164) across tenants — if the same
  // person is in multiple contractors' books, all must honor the stop.
  const dnamRows =
    params.channel === 'email'
      ? await db.execute(
          sql`SELECT 1 FROM public.customers WHERE lower(email) = ${address.toLowerCase()} AND do_not_auto_message = true LIMIT 1`,
        )
      : await db.execute(
          sql`SELECT 1 FROM public.customers WHERE phone = ${address} AND do_not_auto_message = true LIMIT 1`,
        );
  if ((dnamRows as unknown as Array<unknown>).length > 0) {
    return { send: false, defer: false, reason: 'customer_do_not_auto_message' };
  }

  // Send window.
  const timezone = contact.timezone || 'America/Vancouver';
  const windowCheck = checkWindow(now, params.window, timezone);
  if (!windowCheck.ok) {
    return { send: false, defer: true, retryAt: windowCheck.retryAt, reason: 'outside_window' };
  }

  // Frequency cap (email only for now — SMS quiet hours are strict enough).
  if (params.channel === 'email') {
    const cutoff = new Date(now.getTime() - FREQUENCY_CAP_EMAIL_HOURS * 60 * 60 * 1000);
    const [recent] = await db
      .select({ id: arSendLog.id, createdAt: arSendLog.createdAt })
      .from(arSendLog)
      .where(
        and(
          eq(arSendLog.contactId, params.contactId),
          eq(arSendLog.channel, 'email'),
          gte(arSendLog.createdAt, cutoff),
        ),
      )
      .limit(1);
    if (recent) {
      const retryAt = new Date(
        recent.createdAt.getTime() + FREQUENCY_CAP_EMAIL_HOURS * 60 * 60 * 1000,
      );
      return { send: false, defer: true, retryAt, reason: 'frequency_cap' };
    }
  }

  return { send: true };
}
