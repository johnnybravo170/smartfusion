/**
 * GET /api/cron/project-message-notify
 *
 * Drains pending customer-facing notifications for outbound project
 * messages. Same atomic-claim pattern as portal-phase-notify.
 *
 * Eligibility:
 *   notify_scheduled_at <= NOW()
 *   AND notify_sent_at IS NULL
 *   AND notify_cancelled_at IS NULL
 *   AND direction = 'outbound'
 *
 * Auth: Bearer ${CRON_SECRET}.
 *
 * Vercel cron entry: vercel.json — runs every minute. The notify delay
 * is 30 seconds (NOTIFY_DELAY_SECONDS in project-messages.ts), so
 * worst-case latency between scheduled time and send is ~60s.
 */

import { sendMessageNotification } from '@/lib/portal/message-notify';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BATCH_LIMIT = 100;

type DueRow = {
  id: string;
  project_id: string;
  tenant_id: string;
  body: string;
  sender_label: string | null;
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
    .from('project_messages')
    .select('id, project_id, tenant_id, body, sender_label')
    .lte('notify_scheduled_at', nowIso)
    .is('notify_sent_at', null)
    .is('notify_cancelled_at', null)
    .eq('direction', 'outbound')
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
    const { data: claimedRows, error: claimErr } = await admin
      .from('project_messages')
      .update({ notify_sent_at: nowIso })
      .eq('id', row.id)
      .is('notify_sent_at', null)
      .is('notify_cancelled_at', null)
      .select('id');

    if (claimErr) {
      failed++;
      console.error('[project-message-notify] claim failed:', claimErr);
      continue;
    }
    if (!claimedRows || claimedRows.length === 0) {
      // Lost the race — operator hit Undo or another tick claimed it.
      continue;
    }
    claimed++;

    try {
      await sendMessageNotification({
        supabase: admin,
        tenantId: row.tenant_id,
        projectId: row.project_id,
        messageId: row.id,
        body: row.body,
        senderLabel: row.sender_label ?? 'Your contractor',
      });
      sent++;
    } catch (err) {
      failed++;
      console.error('[project-message-notify] send failed:', err);
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
