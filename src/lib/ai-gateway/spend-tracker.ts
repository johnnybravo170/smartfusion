/**
 * Spend tracker. Reads `ai_calls` via the admin client (the table is
 * admin-only RLS) and feeds the tier-progress math.
 *
 * Surfaces queried by the /admin/ai-gateway dashboard:
 *   - getProviderSpendMicros(provider, window)
 *   - getProviderLifetime(provider) → for tier math
 *   - getTierProgress(provider) → composed result
 *   - getRecentFailures(limit) → "last 50 failures" table
 *   - getTopTasksByCostMtd(limit) → "top 10 tasks by cost MTD"
 *   - getVoiceUsageMtd() → voice session metrics from henry_interactions
 */

import { createAdminClient } from '@/lib/supabase/admin';
import type { ProviderName } from './errors';
import { computeTierProgress, type TierProgress } from './tier-ladders';

export type SpendWindow = '24h' | '7d' | '30d' | 'mtd';

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Sum of cost_micros for a provider within a rolling window.
 */
export async function getProviderSpendMicros(
  provider: ProviderName,
  window: SpendWindow,
  now: Date = new Date(),
): Promise<bigint> {
  const since = windowStart(window, now);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('ai_calls')
    .select('cost_micros')
    .eq('provider', provider)
    .eq('status', 'success')
    .gte('created_at', since.toISOString());
  if (error) throw new Error(`spend query failed: ${error.message}`);
  return sumMicros(data ?? []);
}

/**
 * Lifetime spend + first-call timestamp for a provider. Two queries
 * (sum + min) packaged together since they're always read in the
 * same context (tier-progress).
 */
export async function getProviderLifetime(
  provider: ProviderName,
): Promise<{ lifetime_micros: bigint; first_call_at: Date | null }> {
  const admin = createAdminClient();
  const [sumRes, firstRes] = await Promise.all([
    admin.from('ai_calls').select('cost_micros').eq('provider', provider).eq('status', 'success'),
    admin
      .from('ai_calls')
      .select('created_at')
      .eq('provider', provider)
      .eq('status', 'success')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);
  if (sumRes.error) throw new Error(`spend lifetime query failed: ${sumRes.error.message}`);
  if (firstRes.error && firstRes.error.code !== 'PGRST116') {
    throw new Error(`first-call query failed: ${firstRes.error.message}`);
  }
  return {
    lifetime_micros: sumMicros(sumRes.data ?? []),
    first_call_at: firstRes.data?.created_at ? new Date(firstRes.data.created_at as string) : null,
  };
}

export async function getTierProgress(
  provider: ProviderName,
  now: Date = new Date(),
): Promise<TierProgress> {
  const { lifetime_micros, first_call_at } = await getProviderLifetime(provider);
  return computeTierProgress({ provider, lifetime_micros, first_call_at, now });
}

/**
 * "Top N tasks by cost MTD" for the admin dashboard. Server-side
 * aggregation would be ideal but Supabase JS doesn't expose GROUP BY;
 * we pull rows + sum in JS. At ~10k calls/day per active tenant, MTD
 * is ~300k rows — sub-second to aggregate in memory.
 */
export async function getTopTasksByCostMtd(
  limit = 10,
  now: Date = new Date(),
): Promise<Array<{ task: string; cost_micros: bigint; calls: number }>> {
  const admin = createAdminClient();
  const since = startOfMonth(now);
  const { data, error } = await admin
    .from('ai_calls')
    .select('task, cost_micros')
    .eq('status', 'success')
    .gte('created_at', since.toISOString());
  if (error) throw new Error(`top tasks query failed: ${error.message}`);

  const byTask = new Map<string, { cost_micros: bigint; calls: number }>();
  for (const r of data ?? []) {
    const t = r.task as string;
    const c = BigInt((r.cost_micros as number | null) ?? 0);
    const cur = byTask.get(t) ?? { cost_micros: BigInt(0), calls: 0 };
    cur.cost_micros += c;
    cur.calls += 1;
    byTask.set(t, cur);
  }
  return Array.from(byTask.entries())
    .map(([task, v]) => ({ task, ...v }))
    .sort((a, b) => (a.cost_micros < b.cost_micros ? 1 : -1))
    .slice(0, limit);
}

/**
 * Last N failure rows for the admin dashboard's failure feed.
 */
export async function getRecentFailures(limit = 50): Promise<
  Array<{
    created_at: string;
    provider: string;
    task: string;
    status: string;
    latency_ms: number;
    error_message: string | null;
  }>
> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('ai_calls')
    .select('created_at, provider, task, status, latency_ms, error_message')
    .neq('status', 'success')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`recent failures query failed: ${error.message}`);
  return (data ?? []).map((r) => ({
    created_at: r.created_at as string,
    provider: r.provider as string,
    task: r.task as string,
    status: r.status as string,
    latency_ms: r.latency_ms as number,
    error_message: (r.error_message as string | null) ?? null,
  }));
}

/**
 * Per-provider success rate over a window. The admin dashboard
 * surfaces this as a health gauge. Returns success count, error count,
 * and rate (0-1).
 */
export async function getProviderHealth(
  provider: ProviderName,
  window: SpendWindow = '24h',
  now: Date = new Date(),
): Promise<{
  success: number;
  error: number;
  rate: number;
  p50_latency: number;
  p95_latency: number;
}> {
  const admin = createAdminClient();
  const since = windowStart(window, now);
  const { data, error } = await admin
    .from('ai_calls')
    .select('status, latency_ms')
    .eq('provider', provider)
    .gte('created_at', since.toISOString());
  if (error) throw new Error(`health query failed: ${error.message}`);

  let success = 0;
  let errCount = 0;
  const latencies: number[] = [];
  for (const r of data ?? []) {
    if ((r.status as string) === 'success') success++;
    else errCount++;
    if (typeof r.latency_ms === 'number' && r.latency_ms > 0) latencies.push(r.latency_ms);
  }
  latencies.sort((a, b) => a - b);
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  const total = success + errCount;
  return {
    success,
    error: errCount,
    rate: total > 0 ? success / total : 1,
    p50_latency: p50,
    p95_latency: p95,
  };
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function windowStart(window: SpendWindow, now: Date): Date {
  const t = now.getTime();
  switch (window) {
    case '24h':
      return new Date(t - 24 * MS_PER_HOUR);
    case '7d':
      return new Date(t - 7 * MS_PER_DAY);
    case '30d':
      return new Date(t - 30 * MS_PER_DAY);
    case 'mtd':
      return startOfMonth(now);
  }
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0));
}

function sumMicros(rows: Array<{ cost_micros: number | null }>): bigint {
  let total = BigInt(0);
  for (const r of rows) total += BigInt(r.cost_micros ?? 0);
  return total;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * p));
  return sortedAsc[idx];
}

// ----------------------------------------------------------------------
// Voice session metrics (reads henry_interactions, not ai_calls)
// ----------------------------------------------------------------------

export type VoiceProviderStats = {
  provider: string;
  turns: number;
  input_minutes: number;
  output_minutes: number;
};

export type VoiceUsageMtd = {
  /** Total voice turns (log entries) this month. */
  turns: number;
  /** Total mic input in minutes. */
  input_minutes: number;
  /** Total assistant audio output in minutes. */
  output_minutes: number;
  /** Breakdown by provider (openai / gemini). */
  byProvider: VoiceProviderStats[];
};

/**
 * Aggregate voice session metrics for the current calendar month.
 * Queries henry_interactions where provider IS NOT NULL (voice-only rows).
 */
export async function getVoiceUsageMtd(now: Date = new Date()): Promise<VoiceUsageMtd> {
  const admin = createAdminClient();
  const since = startOfMonth(now);
  const { data, error } = await admin
    .from('henry_interactions')
    .select('provider, audio_input_seconds, audio_output_seconds')
    .not('provider', 'is', null)
    .gte('created_at', since.toISOString());
  if (error) throw new Error(`voice usage query failed: ${error.message}`);

  let totalTurns = 0;
  let totalInputSec = 0;
  let totalOutputSec = 0;
  const map = new Map<string, { turns: number; input_sec: number; output_sec: number }>();

  for (const r of data ?? []) {
    const p = r.provider as string;
    totalTurns++;
    const inSec = (r.audio_input_seconds as number | null) ?? 0;
    const outSec = (r.audio_output_seconds as number | null) ?? 0;
    totalInputSec += inSec;
    totalOutputSec += outSec;

    const cur = map.get(p) ?? { turns: 0, input_sec: 0, output_sec: 0 };
    cur.turns++;
    cur.input_sec += inSec;
    cur.output_sec += outSec;
    map.set(p, cur);
  }

  return {
    turns: totalTurns,
    input_minutes: totalInputSec / 60,
    output_minutes: totalOutputSec / 60,
    byProvider: Array.from(map.entries())
      .map(([provider, v]) => ({
        provider,
        turns: v.turns,
        input_minutes: v.input_sec / 60,
        output_minutes: v.output_sec / 60,
      }))
      .sort((a, b) => b.turns - a.turns),
  };
}
