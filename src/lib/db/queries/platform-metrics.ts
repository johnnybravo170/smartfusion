/**
 * Platform-level metrics queries for the admin overview + analytics.
 *
 * All server-only. Uses the service-role client to span every tenant.
 * Never import into operator-facing routes.
 *
 * Timezone: windows resolve in America/Vancouver (PST/PDT) by default,
 * which matches Jonathan's workspace. Override via the `tz` arg.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { demoExclusionList, getDemoTenantIds } from '@/lib/tenants/demo';

export type TimeseriesPoint = { day: string; count: number };
export type TimeseriesMetric = 'signups' | 'interactions' | 'voice_minutes' | 'sms';

const DEFAULT_TZ = 'America/Vancouver';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function windowStart(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** ISO date string (YYYY-MM-DD) for a UTC timestamp, shifted to the given tz. */
function isoDateInTz(ts: string, tz: string): string {
  const d = new Date(ts);
  // en-CA gives YYYY-MM-DD naturally.
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

/** Build an array of the last N days as YYYY-MM-DD strings in tz. */
function lastNDays(days: number, tz: string): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    out.push(d.toLocaleDateString('en-CA', { timeZone: tz }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scalar metrics
// ---------------------------------------------------------------------------

export async function getTotalTenants(): Promise<number> {
  const admin = createAdminClient();
  const { count } = await admin
    .from('tenants')
    .select('*', { count: 'exact', head: true })
    .is('deleted_at', null)
    .not('is_demo', 'is', true);
  return count ?? 0;
}

export async function getSignupsInWindow(days: number): Promise<number> {
  const admin = createAdminClient();
  const { count } = await admin
    .from('tenants')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', windowStart(days))
    .is('deleted_at', null)
    .not('is_demo', 'is', true);
  return count ?? 0;
}

/**
 * Active tenants in a window = any tenant with a Henry interaction, job
 * create, or worklog entry within the window. Union across signals so
 * tenants who don't use Henry yet still show up.
 */
export async function getActiveTenants(days: number): Promise<number> {
  const admin = createAdminClient();
  const since = windowStart(days);
  const demoIds = new Set(await getDemoTenantIds());

  const [interactions, jobs, worklog] = await Promise.all([
    admin.from('henry_interactions').select('tenant_id').gte('created_at', since),
    admin.from('jobs').select('tenant_id').gte('created_at', since).is('deleted_at', null),
    admin.from('worklog_entries').select('tenant_id').gte('created_at', since),
  ]);

  const active = new Set<string>();
  for (const row of interactions.data ?? []) active.add(row.tenant_id);
  for (const row of jobs.data ?? []) active.add(row.tenant_id);
  for (const row of worklog.data ?? []) active.add(row.tenant_id);
  for (const id of demoIds) active.delete(id);
  return active.size;
}

export async function getVoiceMinutesInWindow(days: number): Promise<number> {
  const admin = createAdminClient();
  const exclude = demoExclusionList(await getDemoTenantIds());
  let q = admin
    .from('henry_interactions')
    .select('audio_input_seconds, audio_output_seconds')
    .gte('created_at', windowStart(days));
  if (exclude) q = q.not('tenant_id', 'in', exclude);
  const { data } = await q;
  let totalSeconds = 0;
  for (const row of data ?? []) {
    totalSeconds += Number(row.audio_input_seconds ?? 0);
    totalSeconds += Number(row.audio_output_seconds ?? 0);
  }
  return totalSeconds / 60;
}

export async function getInteractionsInWindow(days: number): Promise<number> {
  const admin = createAdminClient();
  const exclude = demoExclusionList(await getDemoTenantIds());
  let q = admin
    .from('henry_interactions')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', windowStart(days));
  if (exclude) q = q.not('tenant_id', 'in', exclude);
  const { count } = await q;
  return count ?? 0;
}

export async function getSmsInWindow(days: number): Promise<number> {
  const admin = createAdminClient();
  const exclude = demoExclusionList(await getDemoTenantIds());
  let q = admin
    .from('twilio_messages')
    .select('*', { count: 'exact', head: true })
    .eq('direction', 'outbound')
    .gte('created_at', windowStart(days));
  if (exclude) q = q.not('tenant_id', 'in', exclude);
  const { count } = await q;
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Timeseries
// ---------------------------------------------------------------------------

/**
 * Daily counts for the last N days, with gaps zero-filled. Day keys are
 * YYYY-MM-DD in the given tz.
 */
export async function getDailyTimeseries(
  days: number,
  metric: TimeseriesMetric,
  tz: string = DEFAULT_TZ,
): Promise<TimeseriesPoint[]> {
  const admin = createAdminClient();
  const since = windowStart(days);
  const exclude = demoExclusionList(await getDemoTenantIds());
  const buckets = new Map<string, number>();
  for (const d of lastNDays(days, tz)) buckets.set(d, 0);

  if (metric === 'signups') {
    let q = admin.from('tenants').select('created_at').gte('created_at', since);
    q = q.not('is_demo', 'is', true);
    const { data } = await q;
    for (const row of data ?? []) {
      const day = isoDateInTz(row.created_at as string, tz);
      if (buckets.has(day)) buckets.set(day, (buckets.get(day) ?? 0) + 1);
    }
  } else if (metric === 'interactions') {
    let q = admin.from('henry_interactions').select('created_at').gte('created_at', since);
    if (exclude) q = q.not('tenant_id', 'in', exclude);
    const { data } = await q;
    for (const row of data ?? []) {
      const day = isoDateInTz(row.created_at as string, tz);
      if (buckets.has(day)) buckets.set(day, (buckets.get(day) ?? 0) + 1);
    }
  } else if (metric === 'voice_minutes') {
    let q = admin
      .from('henry_interactions')
      .select('created_at, audio_input_seconds, audio_output_seconds')
      .gte('created_at', since);
    if (exclude) q = q.not('tenant_id', 'in', exclude);
    const { data } = await q;
    for (const row of data ?? []) {
      const day = isoDateInTz(row.created_at as string, tz);
      if (!buckets.has(day)) continue;
      const mins =
        (Number(row.audio_input_seconds ?? 0) + Number(row.audio_output_seconds ?? 0)) / 60;
      buckets.set(day, (buckets.get(day) ?? 0) + mins);
    }
  } else if (metric === 'sms') {
    let q = admin
      .from('twilio_messages')
      .select('created_at')
      .eq('direction', 'outbound')
      .gte('created_at', since);
    if (exclude) q = q.not('tenant_id', 'in', exclude);
    const { data } = await q;
    for (const row of data ?? []) {
      const day = isoDateInTz(row.created_at as string, tz);
      if (buckets.has(day)) buckets.set(day, (buckets.get(day) ?? 0) + 1);
    }
  }

  return Array.from(buckets.entries()).map(([day, count]) => ({
    day,
    count: Math.round(count * 100) / 100,
  }));
}

// ---------------------------------------------------------------------------
// Composite overview
// ---------------------------------------------------------------------------

export type PlatformOverview = {
  totalTenants: number;
  activeTenants7d: number;
  activeTenants30d: number;
  signups30d: number;
  interactions30d: number;
  voiceMinutes30d: number;
  sms30d: number;
  avgInteractionsPerActiveTenant30d: number;
};

export async function getPlatformOverview(): Promise<PlatformOverview> {
  const [
    totalTenants,
    activeTenants7d,
    activeTenants30d,
    signups30d,
    interactions30d,
    voiceMinutes30d,
    sms30d,
  ] = await Promise.all([
    getTotalTenants(),
    getActiveTenants(7),
    getActiveTenants(30),
    getSignupsInWindow(30),
    getInteractionsInWindow(30),
    getVoiceMinutesInWindow(30),
    getSmsInWindow(30),
  ]);

  const avgInteractionsPerActiveTenant30d =
    activeTenants30d > 0 ? interactions30d / activeTenants30d : 0;

  return {
    totalTenants,
    activeTenants7d,
    activeTenants30d,
    signups30d,
    interactions30d,
    voiceMinutes30d,
    sms30d,
    avgInteractionsPerActiveTenant30d,
  };
}
