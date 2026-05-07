/**
 * Agent run instrumentation helpers.
 *
 * Use from any in-repo Vercel cron route or other agent-ish loop. The MCP
 * surface (`agent_run_start` / `agent_run_finish`) is the equivalent for
 * Claude Code Routines + Managed Agents.
 *
 * Pattern:
 *
 *   const run = await recordAgentRun({ slug: 'help-doc-writer', trigger: 'schedule' });
 *   try {
 *     // ...do the work, accumulate counters...
 *     await finishAgentRun(run.id, {
 *       outcome: 'success',
 *       items_scanned, items_acted, summary, payload,
 *     });
 *   } catch (e) {
 *     await finishAgentRun(run.id, {
 *       outcome: 'failure',
 *       error: e instanceof Error ? e.message : String(e),
 *     });
 *     throw e;
 *   }
 *
 * If the agent ran but had nothing to do (empty inbox, no candidate
 * commits), use outcome='skipped' — that's the difference between "agent
 * is healthy" and "agent never ran".
 *
 * Idempotency: every call lazily upserts the agent definition (resolved
 * by slug). The seed migration / agents_seed.ts is canonical, but a
 * brand-new agent that calls these helpers won't NPE on a missing FK —
 * we'll insert a stub row and you can fill in name/schedule later via
 * the MCP `agents_upsert` (TODO) or directly in `ops.agents`.
 */

import { createServiceClient } from '@/lib/supabase';

export type AgentRunTrigger = 'schedule' | 'manual' | 'webhook' | 'backfill';
export type AgentRunOutcome = 'success' | 'failure' | 'skipped';

export type RecordRunInput = {
  /** Agent slug — primary key on `ops.agents.slug`. */
  slug: string;
  trigger?: AgentRunTrigger;
};

export type FinishRunInput = {
  outcome: AgentRunOutcome;
  items_scanned?: number;
  items_acted?: number;
  summary?: string | null;
  payload?: unknown;
  error?: string | null;
  cost_usd_micros?: number | null;
};

/**
 * Resolve an agent_id by slug. If the row doesn't exist, insert a stub
 * (status='active', agent_type='cron' as the safest default) so the
 * caller never NPEs on a missing FK. The expectation is that a proper
 * row is later upserted via the seed list.
 */
async function resolveAgentId(slug: string): Promise<string> {
  const service = createServiceClient();
  const { data: existing } = await service
    .schema('ops')
    .from('agents')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();
  if (existing) return existing.id as string;

  const { data: created, error: insertErr } = await service
    .schema('ops')
    .from('agents')
    .insert({
      slug,
      name: slug,
      agent_type: 'cron',
      status: 'active',
    })
    .select('id')
    .single();
  if (insertErr || !created) {
    throw new Error(
      `failed to lazy-create agent row for slug "${slug}": ${insertErr?.message ?? 'unknown'}`,
    );
  }
  return created.id as string;
}

/**
 * Open a run row. Returns the run_id used by `finishAgentRun`.
 *
 * If this throws, the caller should still attempt the work — instrumentation
 * shouldn't gate the agent. Wrap in try/catch and log to console on failure.
 */
export async function recordAgentRun(
  input: RecordRunInput,
): Promise<{ id: string; agent_id: string }> {
  const trigger = input.trigger ?? 'schedule';
  const agentId = await resolveAgentId(input.slug);
  const service = createServiceClient();
  const { data, error } = await service
    .schema('ops')
    .from('agent_runs')
    .insert({
      agent_id: agentId,
      trigger,
      outcome: 'running',
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`failed to open agent_run for "${input.slug}": ${error?.message ?? 'unknown'}`);
  }
  return { id: data.id as string, agent_id: agentId };
}

/**
 * Close a run row. Idempotent — if called twice, the second wins (last
 * outcome / summary persists). Safe to call on a row that's already
 * finished, though that's normally a bug.
 */
export async function finishAgentRun(runId: string, input: FinishRunInput): Promise<void> {
  const service = createServiceClient();
  const { error } = await service
    .schema('ops')
    .from('agent_runs')
    .update({
      finished_at: new Date().toISOString(),
      outcome: input.outcome,
      items_scanned: input.items_scanned ?? null,
      items_acted: input.items_acted ?? null,
      summary: input.summary ?? null,
      payload: input.payload ?? null,
      error: input.error ?? null,
      cost_usd_micros: input.cost_usd_micros ?? null,
    })
    .eq('id', runId);
  if (error) {
    throw new Error(`failed to finish agent_run ${runId}: ${error.message}`);
  }
}

/**
 * Convenience wrapper. Opens a run, runs `fn`, finishes with success
 * (or failure). Returns whatever `fn` returns. The instrumentation
 * never swallows the underlying error — it re-throws after logging
 * the failure outcome.
 *
 * `fn` is given a `report` callback so it can stash partial state on
 * the run before finishing — counters, partial summaries, etc.
 */
export async function withAgentRun<T>(
  input: RecordRunInput,
  fn: (report: (patch: Partial<FinishRunInput>) => void) => Promise<T> | T,
): Promise<T> {
  const run = await recordAgentRun(input);
  let pending: Partial<FinishRunInput> = {};
  const report = (patch: Partial<FinishRunInput>) => {
    pending = { ...pending, ...patch };
  };
  try {
    const result = await fn(report);
    await finishAgentRun(run.id, {
      outcome: pending.outcome ?? 'success',
      items_scanned: pending.items_scanned,
      items_acted: pending.items_acted,
      summary: pending.summary ?? null,
      payload: pending.payload ?? null,
    });
    return result;
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await finishAgentRun(run.id, {
      outcome: 'failure',
      summary: pending.summary ?? null,
      payload: pending.payload ?? null,
      error: err,
    }).catch(() => {
      // Last-ditch: if instrumentation itself fails, don't mask the
      // original error.
    });
    throw e;
  }
}
