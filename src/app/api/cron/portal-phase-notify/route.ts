/**
 * GET /api/cron/portal-phase-notify
 *
 * Drains pending homeowner phase-advance notifications. Phases whose
 * `notify_scheduled_at <= NOW()` AND `notify_sent_at IS NULL` AND
 * `notify_cancelled_at IS NULL` are eligible.
 *
 * For each row: claim atomically (stamp notify_sent_at via a guarded
 * UPDATE), then send SMS + email + write the operator-side
 * project_portal_updates feed row. Errors per row don't fail the batch
 * — one flaky Twilio call shouldn't poison the queue.
 *
 * Auth: Bearer ${CRON_SECRET}.
 *
 * Vercel cron entry: vercel.json — runs every minute. The notify delay
 * is 5 minutes, so the cron ticks 5 times during the contractor's Undo
 * window before any send happens. Worst-case latency between scheduled
 * time and send is ~60s.
 */

import { sendPhaseNotification } from '@/lib/portal/phase-notify';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BATCH_LIMIT = 100;

type DueRow = {
  id: string;
  project_id: string;
  tenant_id: string;
  name: string;
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
    .from('project_phases')
    .select('id, project_id, tenant_id, name')
    .lte('notify_scheduled_at', nowIso)
    .is('notify_sent_at', null)
    .is('notify_cancelled_at', null)
    .not('notify_scheduled_at', 'is', null)
    .limit(BATCH_LIMIT);

  if (queryErr) {
    return Response.json({ ok: false, error: queryErr.message }, { status: 500 });
  }

  const rows = (due ?? []) as DueRow[];
  let claimed = 0;
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    // Atomic claim: stamp notify_sent_at only if it's still NULL and
    // not cancelled. If the operator hit Undo between our SELECT and
    // here, the UPDATE returns 0 rows and we skip.
    const { data: claimedRows, error: claimErr } = await admin
      .from('project_phases')
      .update({ notify_sent_at: nowIso })
      .eq('id', row.id)
      .is('notify_sent_at', null)
      .is('notify_cancelled_at', null)
      .select('id');

    if (claimErr) {
      failed++;
      console.error('[portal-phase-notify] claim failed:', claimErr);
      continue;
    }
    if (!claimedRows || claimedRows.length === 0) {
      // Lost the race (cancelled or already sent). Skip silently.
      continue;
    }
    claimed++;

    try {
      await sendPhaseNotification({
        supabase: admin,
        tenantId: row.tenant_id,
        projectId: row.project_id,
        phaseId: row.id,
        phaseName: row.name,
      });
      sent++;
    } catch (err) {
      failed++;
      console.error('[portal-phase-notify] send failed:', err);
      // We've already stamped notify_sent_at, so this row won't retry.
      // That's intentional: send-side failures (Twilio outage, bad
      // phone number, etc.) shouldn't repeatedly hammer the homeowner
      // if the cron retries. The error is logged for ops follow-up.
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
