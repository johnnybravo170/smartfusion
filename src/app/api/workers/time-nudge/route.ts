/**
 * GET /api/workers/time-nudge
 *
 * Daily 7pm cron (America/Edmonton). For every worker scheduled to a project
 * today who hasn't logged any time_entries for today, send an email (and SMS
 * if nudge_sms is on) prompting them to log their hours.
 *
 * Runs once per day, so no dedupe is needed — a repeat manual run would
 * re-send, which is acceptable for a cron endpoint gated by CRON_SECRET.
 */

import { sendEmail } from '@/lib/email/send';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendSms } from '@/lib/twilio/client';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function todayInEdmonton(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' });
}

type PendingWorker = {
  tenant_id: string;
  worker_profile_id: string;
  tenant_member_id: string;
  display_name: string | null;
  phone: string | null;
  nudge_email: boolean;
  nudge_sms: boolean;
  user_id: string;
};

export async function GET(request: Request) {
  const auth = request.headers.get('authorization');
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  const today = todayInEdmonton();

  // 1. Workers scheduled today.
  const { data: assignRows } = await admin
    .from('project_assignments')
    .select('tenant_id, worker_profile_id')
    .eq('scheduled_date', today);

  const pairs = new Map<string, { tenant_id: string; worker_profile_id: string }>();
  for (const a of assignRows ?? []) {
    const key = `${a.tenant_id as string}|${a.worker_profile_id as string}`;
    pairs.set(key, {
      tenant_id: a.tenant_id as string,
      worker_profile_id: a.worker_profile_id as string,
    });
  }

  if (pairs.size === 0) {
    return Response.json({ ok: true, scheduled: 0, nudged: 0 });
  }

  // 2. Drop anyone who already logged time today.
  const workerIds = Array.from(pairs.values()).map((p) => p.worker_profile_id);
  const { data: loggedRows } = await admin
    .from('time_entries')
    .select('worker_profile_id')
    .eq('entry_date', today)
    .in('worker_profile_id', workerIds);
  const loggedIds = new Set((loggedRows ?? []).map((r) => r.worker_profile_id as string));

  const pending = Array.from(pairs.values()).filter((p) => !loggedIds.has(p.worker_profile_id));
  if (pending.length === 0) {
    return Response.json({ ok: true, scheduled: pairs.size, nudged: 0 });
  }

  // 3. Enrich with worker profile + tenant_member.
  const pendingIds = pending.map((p) => p.worker_profile_id);
  const { data: profiles } = await admin
    .from('worker_profiles')
    .select('id, tenant_id, tenant_member_id, display_name, phone, nudge_email, nudge_sms')
    .in('id', pendingIds);
  const { data: members } = await admin
    .from('tenant_members')
    .select('id, user_id')
    .in(
      'id',
      (profiles ?? []).map((p) => p.tenant_member_id as string),
    );
  const memberById = new Map((members ?? []).map((m) => [m.id as string, m.user_id as string]));

  const { data: tenants } = await admin
    .from('tenants')
    .select('id, name')
    .in('id', Array.from(new Set(pending.map((p) => p.tenant_id))));
  const tenantName = new Map((tenants ?? []).map((t) => [t.id as string, t.name as string]));

  const workers: PendingWorker[] = [];
  for (const p of profiles ?? []) {
    const userId = memberById.get(p.tenant_member_id as string);
    if (!userId) continue;
    workers.push({
      tenant_id: p.tenant_id as string,
      worker_profile_id: p.id as string,
      tenant_member_id: p.tenant_member_id as string,
      display_name: (p.display_name as string | null) ?? null,
      phone: (p.phone as string | null) ?? null,
      nudge_email: (p.nudge_email as boolean) ?? true,
      nudge_sms: (p.nudge_sms as boolean) ?? false,
      user_id: userId,
    });
  }

  let emailed = 0;
  let texted = 0;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.heyhenry.io';
  const logUrl = `${appUrl}/w/time/new`;

  for (const w of workers) {
    const who = w.display_name ?? 'there';
    const tenant = tenantName.get(w.tenant_id) ?? 'your crew';
    const body = `Hey ${who} — quick reminder to log today\u2019s hours for ${tenant}. ${logUrl}`;

    if (w.nudge_email) {
      const { data: authUser } = await admin.auth.admin.getUserById(w.user_id);
      const email = authUser?.user?.email;
      if (email) {
        const res = await sendEmail({
          to: email,
          subject: 'Log today\u2019s hours',
          tenantId: w.tenant_id,
          html: `<p>Hey ${who},</p><p>Quick reminder to log today\u2019s hours for <strong>${tenant}</strong> before you wind down.</p><p><a href="${logUrl}">Log hours \u2192</a></p>`,
          caslCategory: 'transactional',
          relatedType: 'time_nudge',
          relatedId: w.user_id,
          caslEvidence: { kind: 'time_nudge', workerId: w.user_id },
        });
        if (res.ok) emailed += 1;
      }
    }

    if (w.nudge_sms && w.phone) {
      const res = await sendSms({
        tenantId: w.tenant_id,
        to: w.phone,
        body,
        identity: 'operator',
        caslCategory: 'transactional',
        caslEvidence: { kind: 'time_nudge', workerId: w.user_id },
      });
      if (res.ok) texted += 1;
    }
  }

  return Response.json({
    ok: true,
    scheduled: pairs.size,
    nudged: workers.length,
    emailed,
    texted,
  });
}
