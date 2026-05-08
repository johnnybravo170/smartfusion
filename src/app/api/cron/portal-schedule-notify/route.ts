/**
 * GET /api/cron/portal-schedule-notify
 *
 * Drains pending homeowner schedule-update notifications. Projects whose
 * `schedule_notify_scheduled_at <= NOW()` AND `schedule_notify_sent_at IS
 * NULL` AND `schedule_notify_cancelled_at IS NULL` are eligible.
 *
 * For each row: claim atomically (stamp schedule_notify_sent_at via a
 * guarded UPDATE), then send SMS + email. Errors per row don't fail the
 * batch — one flaky Twilio call shouldn't poison the queue.
 *
 * Auth: Bearer ${CRON_SECRET}.
 *
 * Vercel cron entry: vercel.json — runs every minute. The notify delay
 * is 5 minutes, so the cron ticks 5 times during the operator's edit
 * window before any send happens. Worst-case latency between scheduled
 * time and send is ~60s.
 */

import { sendScheduleNotification } from '@/lib/portal/schedule-notify';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BATCH_LIMIT = 100;

type DueRow = {
  id: string;
  tenant_id: string;
};

export async function GET(request: Request) {
  const auth = request.headers.get('authorization');
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  const { data: due, error: queryErr } = await admin
    .from('projects')
    .select('id, tenant_id')
    .lte('schedule_notify_scheduled_at', nowIso)
    .is('schedule_notify_sent_at', null)
    .is('schedule_notify_cancelled_at', null)
    .not('schedule_notify_scheduled_at', 'is', null)
    .limit(BATCH_LIMIT);

  if (queryErr) {
    return Response.json({ ok: false, error: queryErr.message }, { status: 500 });
  }

  const rows = (due ?? []) as DueRow[];
  let claimed = 0;
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    // Atomic claim: stamp schedule_notify_sent_at only if it's still
    // NULL and not cancelled. If the operator made another edit between
    // our SELECT and here (which would have re-scheduled with a fresh
    // notify_scheduled_at), the UPDATE is still allowed — the stamp
    // marks this fire as done, and the next round will pick up any new
    // pending state.
    const { data: claimedRows, error: claimErr } = await admin
      .from('projects')
      .update({ schedule_notify_sent_at: nowIso })
      .eq('id', row.id)
      .is('schedule_notify_sent_at', null)
      .is('schedule_notify_cancelled_at', null)
      .select('id');

    if (claimErr) {
      failed++;
      console.error('[portal-schedule-notify] claim failed:', claimErr);
      continue;
    }
    if (!claimedRows || claimedRows.length === 0) {
      // Lost the race (cancelled or already sent). Skip silently.
      continue;
    }
    claimed++;

    try {
      await sendScheduleNotification({
        supabase: admin,
        tenantId: row.tenant_id,
        projectId: row.id,
      });
      sent++;
    } catch (err) {
      failed++;
      console.error('[portal-schedule-notify] send failed:', err);
      // We've already stamped schedule_notify_sent_at, so this row
      // won't retry. Send-side failures (Twilio outage, bad phone
      // number, etc.) shouldn't repeatedly hammer the homeowner if the
      // cron retries. The error is logged for ops follow-up.
    }
  }

  return Response.json({
    ok: true,
    eligible: rows.length,
    claimed,
    sent,
    failed,
  });
}
