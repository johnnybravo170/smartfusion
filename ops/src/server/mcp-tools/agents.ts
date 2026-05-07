/**
 * MCP tools for agent run instrumentation + registry management.
 *
 * Routines + Managed Agents call `agent_run_start` / `agent_run_finish`
 * around their work loop; their outputs land as `ops.agent_runs` rows
 * and surface in `ops.heyhenry.io/agents`.
 *
 * In-repo Vercel crons should use `ops/src/lib/agents/index.ts` directly
 * (no MCP round-trip needed) — same data shape lands in the same table.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createServiceClient } from '@/lib/supabase';
import { jsonResult, type McpToolCtx, withAudit } from './context';

const RUN_OUTCOME = z.enum(['success', 'failure', 'skipped']);
const RUN_TRIGGER = z.enum(['schedule', 'manual', 'webhook', 'backfill']);
const AGENT_TYPE = z.enum(['routine', 'cron', 'managed']);
const AGENT_STATUS = z.enum(['active', 'disabled', 'archived']);

export function registerAgentTools(server: McpServer, ctx: McpToolCtx) {
  // ──────────────────────────────────────────────────────────────────
  // agent_run_start — open a run row at the top of the agent loop
  // ──────────────────────────────────────────────────────────────────
  server.tool(
    'agent_run_start',
    [
      'Open a new agent_run row. Call this at the very top of the agent loop, before any other work. Returns a run_id you must pass to `agent_run_finish` at the end.',
      '',
      "If the agent slug doesn't exist in `ops.agents` yet, a stub row is auto-inserted (status=active, agent_type=routine for safety). Fill in name/schedule via `agents_upsert` later.",
    ].join('\n'),
    {
      slug: z.string().min(1).max(120),
      trigger: RUN_TRIGGER.default('schedule'),
    },
    withAudit(ctx, 'agent_run_start', 'write:agents:run', async ({ slug, trigger }) => {
      const service = createServiceClient();

      const { data: existing } = await service
        .schema('ops')
        .from('agents')
        .select('id')
        .eq('slug', slug)
        .maybeSingle();
      let agentId = existing?.id as string | undefined;
      if (!agentId) {
        const { data: created, error: insErr } = await service
          .schema('ops')
          .from('agents')
          .insert({ slug, name: slug, agent_type: 'routine', status: 'active' })
          .select('id')
          .single();
        if (insErr || !created) throw new Error(insErr?.message ?? 'lazy-create failed');
        agentId = created.id as string;
      }

      const { data: run, error } = await service
        .schema('ops')
        .from('agent_runs')
        .insert({ agent_id: agentId, trigger, outcome: 'running' })
        .select('id')
        .single();
      if (error || !run) throw new Error(error?.message ?? 'open run failed');

      return jsonResult({ ok: true, run_id: run.id, agent_id: agentId });
    }),
  );

  // ──────────────────────────────────────────────────────────────────
  // agent_run_finish — close a run row
  // ──────────────────────────────────────────────────────────────────
  server.tool(
    'agent_run_finish',
    [
      'Close an agent_run row opened by `agent_run_start`. Required at the end of every loop, including failure paths.',
      '',
      'Outcome rules:',
      '  - "success" — did the work, produced the expected output',
      '  - "skipped" — agent ran but had nothing to do (empty inbox, no candidate commits). NOT a failure.',
      '  - "failure" — the agent crashed or hit an unrecoverable error. Set `error`.',
      '',
      '`summary` is one line shown in the dashboard list view. `payload` is structured detail (action lists, verdicts, sub-results) shown in the detail view.',
    ].join('\n'),
    {
      run_id: z.string().uuid(),
      outcome: RUN_OUTCOME,
      items_scanned: z.number().int().nonnegative().optional(),
      items_acted: z.number().int().nonnegative().optional(),
      summary: z.string().max(500).optional(),
      payload: z.unknown().optional(),
      error: z.string().max(2000).optional(),
      cost_usd_micros: z.number().int().nonnegative().optional(),
    },
    withAudit(ctx, 'agent_run_finish', 'write:agents:run', async (input) => {
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
        .eq('id', input.run_id);
      if (error) throw new Error(error.message);
      return jsonResult({ ok: true, run_id: input.run_id });
    }),
  );

  // ──────────────────────────────────────────────────────────────────
  // agents_list — read-only registry inspection
  // ──────────────────────────────────────────────────────────────────
  server.tool(
    'agents_list',
    'List agents in the registry, with their current health (latest run + computed status).',
    {
      status: AGENT_STATUS.optional(),
      agent_type: AGENT_TYPE.optional(),
      tag: z.string().max(50).optional(),
      limit: z.number().int().min(1).max(200).default(100),
    },
    withAudit(ctx, 'agents_list', 'read:agents', async ({ status, agent_type, tag, limit }) => {
      const service = createServiceClient();
      let q = service
        .schema('ops')
        .from('agent_health')
        .select('*')
        .order('latest_started_at', { ascending: false, nullsFirst: false })
        .limit(limit);
      if (status) q = q.eq('agent_status', status);
      if (agent_type) q = q.eq('agent_type', agent_type);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const filtered = tag
        ? (data ?? []).filter(() => true) // tag filter applied below if needed
        : (data ?? []);
      // Tag filter requires reading from ops.agents (not in the view).
      if (tag && filtered.length > 0) {
        const ids = filtered.map((r) => r.agent_id as string);
        const { data: tagged } = await service
          .schema('ops')
          .from('agents')
          .select('id, tags')
          .in('id', ids);
        const matchSet = new Set(
          (tagged ?? []).filter((a) => (a.tags as string[]).includes(tag)).map((a) => a.id),
        );
        return jsonResult({ agents: filtered.filter((r) => matchSet.has(r.agent_id)) });
      }
      return jsonResult({ agents: filtered });
    }),
  );

  // ──────────────────────────────────────────────────────────────────
  // agents_upsert — definition management
  // ──────────────────────────────────────────────────────────────────
  server.tool(
    'agents_upsert',
    [
      'Create or update an agent definition. Idempotent on slug.',
      '',
      "Use this to formalize an agent's metadata (name, schedule, owner, expected_max_gap_minutes for staleness alerting). Lazy-created stubs from `agent_run_start` should be filled in here.",
    ].join('\n'),
    {
      slug: z.string().min(1).max(120),
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(2000).optional(),
      agent_type: AGENT_TYPE.optional(),
      schedule: z.string().max(120).optional(),
      external_link: z.string().max(500).optional(),
      owner: z.string().max(120).optional(),
      status: AGENT_STATUS.optional(),
      expected_max_gap_minutes: z.number().int().positive().nullable().optional(),
      tags: z.array(z.string().min(1).max(50)).max(20).optional(),
    },
    withAudit(ctx, 'agents_upsert', 'admin:agents', async ({ slug, ...patch }) => {
      const service = createServiceClient();
      const { data: existing } = await service
        .schema('ops')
        .from('agents')
        .select('id')
        .eq('slug', slug)
        .maybeSingle();
      if (existing) {
        const update: Record<string, unknown> = {};
        if (patch.name !== undefined) update.name = patch.name;
        if (patch.description !== undefined) update.description = patch.description;
        if (patch.agent_type !== undefined) update.agent_type = patch.agent_type;
        if (patch.schedule !== undefined) update.schedule = patch.schedule;
        if (patch.external_link !== undefined) update.external_link = patch.external_link;
        if (patch.owner !== undefined) update.owner = patch.owner;
        if (patch.status !== undefined) update.status = patch.status;
        if (patch.expected_max_gap_minutes !== undefined)
          update.expected_max_gap_minutes = patch.expected_max_gap_minutes;
        if (patch.tags !== undefined) update.tags = patch.tags;
        if (Object.keys(update).length === 0) {
          return jsonResult({ ok: true, id: existing.id, changed: false });
        }
        const { error } = await service
          .schema('ops')
          .from('agents')
          .update(update)
          .eq('id', existing.id as string);
        if (error) throw new Error(error.message);
        return jsonResult({ ok: true, id: existing.id, changed: true });
      }
      // Insert path. Require name + agent_type for fresh rows.
      if (!patch.name || !patch.agent_type) {
        return jsonResult({
          ok: false,
          error: 'name and agent_type are required when creating a new agent',
        });
      }
      const { data: created, error } = await service
        .schema('ops')
        .from('agents')
        .insert({
          slug,
          name: patch.name,
          description: patch.description ?? null,
          agent_type: patch.agent_type,
          schedule: patch.schedule ?? null,
          external_link: patch.external_link ?? null,
          owner: patch.owner ?? null,
          status: patch.status ?? 'active',
          expected_max_gap_minutes: patch.expected_max_gap_minutes ?? null,
          tags: patch.tags ?? [],
        })
        .select('id')
        .single();
      if (error || !created) throw new Error(error?.message ?? 'insert failed');
      return jsonResult({ ok: true, id: created.id, changed: true, created: true });
    }),
  );
}
