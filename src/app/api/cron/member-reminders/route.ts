/**
 * Recurring reminder cron — runs every 15 min.
 *
 * For each enabled reminder:
 *   1. Compute the current local time in the tenant's timezone
 *   2. Bail if today's day-of-week isn't in days_of_week
 *   3. Bail if local_time is not within the next 15-min window after now
 *      (we fire when wall-clock crosses the configured time)
 *   4. Bail if last_sent_at is within the last 18h (per-day dedupe)
 *   5. Send SMS via the recipient's notification_phone (fallback: phone)
 *   6. Stamp last_sent_at
 *
 * Push notifications are a one-line swap inside the channel switch when the
 * native app ships.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { sendSms } from '@/lib/twilio/client';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const WINDOW_MINUTES = 15;
const DEDUPE_HOURS = 18;
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://app.heyhenry.io').replace(/\/$/, '');

type ReminderRow = {
  id: string;
  tenant_id: string;
  tenant_member_id: string;
  kind: string;
  local_time: string;
  days_of_week: number[];
  channel: string;
  last_sent_at: string | null;
};

type MemberRow = {
  id: string;
  user_id: string;
  notification_phone: string | null;
  phone: string | null;
  first_name: string | null;
};

type TenantRow = {
  id: string;
  timezone: string | null;
  name: string;
};

function bodyFor(kind: string, firstName: string | null): string {
  const name = firstName?.trim() || 'there';
  switch (kind) {
    case 'daily_logging':
      return `Hey ${name} — quick reminder to log today's time and receipts in HeyHenry. ${APP_URL}/dashboard`;
    case 'weekly_review':
      return `Hey ${name} — end-of-week review time. Check your open quotes, jobs, and unpaid invoices: ${APP_URL}/dashboard`;
    default:
      return `Reminder from HeyHenry: ${APP_URL}/dashboard`;
  }
}

function localNowParts(timezone: string, now: Date): { dow: number; hhmm: string } {
  // Intl.DateTimeFormat with an explicit timezone is the only zone-correct
  // way to extract local components in node without pulling in tzdata libs.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const weekdayStr = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { dow: dowMap[weekdayStr] ?? 0, hhmm: `${hour === '24' ? '00' : hour}:${minute}` };
}

function withinWindow(targetHHMM: string, nowHHMM: string): boolean {
  const [th, tm] = targetHHMM.split(':').map(Number);
  const [nh, nm] = nowHHMM.split(':').map(Number);
  const targetMins = (th ?? 0) * 60 + (tm ?? 0);
  const nowMins = (nh ?? 0) * 60 + (nm ?? 0);
  // Fire if now is in [target, target + WINDOW_MINUTES). Cron runs every
  // 15 min so each due reminder gets exactly one shot.
  return nowMins >= targetMins && nowMins < targetMins + WINDOW_MINUTES;
}

export async function GET() {
  const admin = createAdminClient();
  const now = new Date();
  const dedupeCutoff = new Date(now.getTime() - DEDUPE_HOURS * 60 * 60 * 1000).toISOString();

  const { data: reminders, error } = await admin
    .from('member_reminders')
    .select(
      'id, tenant_id, tenant_member_id, kind, local_time, days_of_week, channel, last_sent_at',
    )
    .eq('enabled', true)
    .or(`last_sent_at.is.null,last_sent_at.lt.${dedupeCutoff}`);

  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (reminders ?? []) as ReminderRow[];
  let attempted = 0;
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  // Cache tenants + members across the loop — most cron passes touch a small
  // distinct set.
  const tenantCache = new Map<string, TenantRow | null>();
  const memberCache = new Map<string, MemberRow | null>();

  async function loadTenant(id: string) {
    if (tenantCache.has(id)) return tenantCache.get(id)!;
    const { data } = await admin
      .from('tenants')
      .select('id, timezone, name')
      .eq('id', id)
      .maybeSingle();
    const row = (data as TenantRow | null) ?? null;
    tenantCache.set(id, row);
    return row;
  }
  async function loadMember(id: string) {
    if (memberCache.has(id)) return memberCache.get(id)!;
    const { data } = await admin
      .from('tenant_members')
      .select('id, user_id, notification_phone, phone, first_name')
      .eq('id', id)
      .maybeSingle();
    const row = (data as MemberRow | null) ?? null;
    memberCache.set(id, row);
    return row;
  }

  for (const r of rows) {
    const tenant = await loadTenant(r.tenant_id);
    if (!tenant) {
      skipped++;
      continue;
    }
    const tz = tenant.timezone || 'America/Vancouver';
    const { dow, hhmm } = localNowParts(tz, now);
    if (!Array.isArray(r.days_of_week) || !r.days_of_week.includes(dow)) {
      skipped++;
      continue;
    }
    if (!withinWindow(r.local_time, hhmm)) {
      skipped++;
      continue;
    }

    attempted++;
    const member = await loadMember(r.tenant_member_id);
    if (!member) {
      failed++;
      continue;
    }
    const to = member.notification_phone || member.phone;
    if (!to) {
      failed++;
      continue;
    }

    if (r.channel === 'sms') {
      const result = await sendSms({
        tenantId: r.tenant_id,
        to,
        body: bodyFor(r.kind, member.first_name),
        identity: 'operator',
        caslCategory: 'transactional',
        relatedType: 'platform',
        relatedId: r.id,
      });
      if (!result.ok) {
        failed++;
        continue;
      }
    } else {
      // 'email' and 'push' channels not yet wired; skip without erroring so
      // an operator who picked them in the UI doesn't break the cron loop.
      skipped++;
      continue;
    }

    await admin.from('member_reminders').update({ last_sent_at: now.toISOString() }).eq('id', r.id);
    sent++;
  }

  return Response.json({ ok: true, attempted, sent, skipped, failed });
}
