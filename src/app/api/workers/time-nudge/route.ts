/**
 * GET /api/workers/time-nudge
 *
 * Daily cron. For every worker scheduled to a project today (in their
 * tenant's local timezone) who hasn't logged any time_entries for today,
 * send an email (and SMS if nudge_sms is on) prompting them to log their
 * hours.
 *
 * Runs once per day, so no dedupe is needed — a repeat manual run would
 * re-send, which is acceptable for a cron endpoint gated by CRON_SECRET.
 */

import { sendEmail } from '@/lib/email/send';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendSms } from '@/lib/twilio/client';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function localDate(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
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

  // "Today" depends on the tenant's local timezone — the cron fires once per
  // day at a fixed UTC instant, but each tenant's calendar date at that
  // instant differs by zone. Pull a 3-day window of assignments and filter
  // per-tenant against their local today. Format candidate dates explicitly
  // in UTC so they're stable regardless of runtime tz.
  const utcNow = new Date();
  const dayMs = 86_400_000;
  const utcFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' });
  const candidateDates = [
    utcFmt.format(new Date(utcNow.getTime() - dayMs)),
    utcFmt.format(utcNow),
    utcFmt.format(new Date(utcNow.getTime() + dayMs)),
  ];

  const { data: assignRows } = await admin
    .from('project_assignments')
    .select('tenant_id, worker_profile_id, scheduled_date')
    .in('scheduled_date', candidateDates);

  const tenantIds = Array.from(new Set((assignRows ?? []).map((a) => a.tenant_id as string)));
  const { data: tenantRows } = await admin
    .from('tenants')
    .select('id, timezone')
    .in('id', tenantIds);
  const tenantTzById = new Map<string, string>(
    (tenantRows ?? []).map((t) => [
      t.id as string,
      (t.timezone as string | null) ?? 'America/Vancouver',
    ]),
  );
  const todayByTenant = new Map<string, string>();
  for (const tid of tenantIds) {
    todayByTenant.set(tid, localDate(tenantTzById.get(tid) ?? 'America/Vancouver'));
  }

  const pairs = new Map<string, { tenant_id: string; worker_profile_id: string }>();
  for (const a of assignRows ?? []) {
    const tid = a.tenant_id as string;
    const sched = a.scheduled_date as string;
    if (todayByTenant.get(tid) !== sched) continue;
    const key = `${tid}|${a.worker_profile_id as string}`;
    pairs.set(key, { tenant_id: tid, worker_profile_id: a.worker_profile_id as string });
  }

  if (pairs.size === 0) {
    return Response.json({ ok: true, scheduled: 0, nudged: 0 });
  }

  // Drop anyone who already logged time on their tenant-local today.
  const workerIds = Array.from(pairs.values()).map((p) => p.worker_profile_id);
  const { data: loggedRows } = await admin
    .from('time_entries')
    .select('worker_profile_id, tenant_id, entry_date')
    .in('worker_profile_id', workerIds)
    .in('entry_date', candidateDates);
  const loggedKeys = new Set<string>();
  for (const r of loggedRows ?? []) {
    const tid = r.tenant_id as string;
    if (todayByTenant.get(tid) !== r.entry_date) continue;
    loggedKeys.add(`${tid}|${r.worker_profile_id as string}`);
  }

  const pending = Array.from(pairs.entries())
    .filter(([key]) => !loggedKeys.has(key))
    .map(([, v]) => v);
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
