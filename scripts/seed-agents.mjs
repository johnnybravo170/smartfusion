#!/usr/bin/env node
/**
 * Seed `ops.agents` with the current agent fleet + backfill 30 days of
 * historical runs from existing telemetry.
 *
 * Idempotent. Re-runs upsert agent rows by slug; backfill skips runs that
 * already exist (dedup on agent_id + started_at).
 *
 * Run with:
 *   node --env-file=.env.local scripts/seed-agents.mjs
 *
 * Maps:
 *   - Vercel crons → signal: ops.worklog_entries by actor_name
 *   - Routines → signal: ops.audit_log by OAuth subject + path heuristics
 */

import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1, prepare: false });

const FLEET = [
  // ─── Vercel crons (in-repo) ───────────────────────────────────────
  {
    slug: 'feedback-triage',
    name: 'Feedback Triage',
    description:
      'Hourly. Classifies in-app feedback cards (keep/noise/dedup) and surfaces open Sentry incidents as kanban cards.',
    agent_type: 'cron',
    schedule: '10 * * * *',
    external_link: 'https://vercel.com/johnnybravo170s-projects',
    owner: 'jonathan',
    expected_max_gap_minutes: 90,
    tags: ['ops', 'triage'],
    backfill_actor_name: 'feedback-triage',
  },
  {
    slug: 'git-stats',
    name: 'Git Stats',
    description: 'Hourly. Refreshes ops.git_daily_stats from GitHub commits (LOC, contributors).',
    agent_type: 'cron',
    schedule: '0 * * * *',
    external_link: 'https://vercel.com/johnnybravo170s-projects',
    owner: 'jonathan',
    expected_max_gap_minutes: 90,
    tags: ['ops', 'metrics'],
    backfill_actor_name: 'git-stats',
  },
  {
    slug: 'maintenance-weekly',
    name: 'Weekly Maintenance',
    description:
      'Mon 14:00 UTC. Archives stale worklog entries; generates weekly digest pinned to the worklog feed.',
    agent_type: 'cron',
    schedule: '0 14 * * 1',
    external_link: 'https://vercel.com/johnnybravo170s-projects',
    owner: 'jonathan',
    expected_max_gap_minutes: 60 * 24 * 8, // 8 days
    tags: ['ops', 'maintenance'],
    backfill_actor_name: 'weekly-digest',
  },
  {
    slug: 'help-doc-writer',
    name: 'Help Doc Writer (operator-audience)',
    description:
      'Daily 13:30 UTC. Drafts operator-voiced help_docs from merged PRs. Drafts land is_published=false for human review.',
    agent_type: 'cron',
    schedule: '30 13 * * *',
    external_link: 'https://vercel.com/johnnybravo170s-projects',
    owner: 'jonathan',
    expected_max_gap_minutes: 60 * 30, // 30h
    tags: ['ai', 'help-docs', 'doc-writer'],
    backfill_actor_name: 'help-doc-writer',
  },

  // ─── Claude Code Routines ──────────────────────────────────────────
  {
    slug: 'doc-writer',
    name: 'Doc Writer (engineer-audience)',
    description:
      'Daily 5:00 AM PDT. Maintains ops.docs and ops.knowledge_docs with module-level summaries from recent commit ranges.',
    agent_type: 'routine',
    schedule: '0 12 * * *', // 5am PDT in UTC (approx)
    external_link: 'https://claude.ai/code/routines',
    owner: 'jonathan',
    expected_max_gap_minutes: 60 * 30,
    tags: ['ai', 'docs', 'routine'],
    backfill_actor_name: null, // OAuth-authed; backfill via audit_log
  },
  {
    slug: 'helpdesk-triage',
    name: 'Helpdesk Triage',
    description:
      'On-demand or scheduled. Reads codebase via Grep/Glob/Read for cards tagged `triage:claude`; comments diagnosis + path:line refs + suggested fix + size hint.',
    agent_type: 'routine',
    schedule: 'on-demand',
    external_link: 'https://claude.ai/code/routines',
    owner: 'jonathan',
    expected_max_gap_minutes: null, // on-demand; never alert
    tags: ['ai', 'triage', 'routine'],
    backfill_actor_name: null,
  },
  {
    slug: 'weekly-dispatcher',
    name: 'Weekly Dispatcher',
    description:
      'Mondays 6 AM. Narrative summary of the past 7 days across worklog/kanban/incidents/competitors/docs/git. Pins to the worklog as weekly_digest.',
    agent_type: 'routine',
    schedule: 'Mon 6:00 AM',
    external_link: 'https://claude.ai/code/routines',
    owner: 'jonathan',
    expected_max_gap_minutes: 60 * 24 * 8, // 8 days
    tags: ['ai', 'narrative', 'routine', 'remote'],
    backfill_actor_name: 'dispatcher',
  },
  {
    slug: 'ai-tools-scout',
    name: 'AI Tools Scout',
    description:
      'Daily 7 AM. Scans for new AI/agent tooling releases; writes ideas + knowledge entries when something matters.',
    agent_type: 'routine',
    schedule: 'Daily 7:00 AM',
    external_link: 'https://claude.ai/code/routines',
    owner: 'jonathan',
    expected_max_gap_minutes: 60 * 30,
    tags: ['ai', 'scout', 'routine', 'remote'],
    backfill_actor_name: 'ai-tools-scout',
  },
  {
    slug: 'business-scout',
    name: 'Business Scout',
    description:
      'Daily 6 AM. Synthesis agent: connects HeyHenry internal signals + market context into 2–3 strategic moves. Writes ideas + email digest.',
    agent_type: 'routine',
    schedule: 'Daily 6:00 AM',
    external_link: 'https://claude.ai/code/routines',
    owner: 'jonathan',
    expected_max_gap_minutes: 60 * 30,
    tags: ['scout', 'business', 'routine', 'remote'],
    backfill_actor_name: 'business-scout',
  },
  {
    slug: 'pain-points-research',
    name: 'Pain Points Research',
    description:
      'Daily 7 AM. Scrapes contractor-community sources for recurring pain points; lands social_drafts + ideas.',
    agent_type: 'routine',
    schedule: 'Daily 7:00 AM',
    external_link: 'https://claude.ai/code/routines',
    owner: 'jonathan',
    expected_max_gap_minutes: 60 * 30,
    tags: ['research', 'social', 'routine', 'remote'],
    backfill_actor_name: 'pain-points-research',
  },
  {
    slug: 'security-probe',
    name: 'Security Probe',
    description:
      'Daily 4 AM. Reviews recent code changes + dependency updates for security issues; opens incidents on findings.',
    agent_type: 'routine',
    schedule: 'Daily 4:00 AM',
    external_link: 'https://claude.ai/code/routines',
    owner: 'jonathan',
    expected_max_gap_minutes: 60 * 30,
    tags: ['security', 'routine', 'remote'],
    backfill_actor_name: 'security-probe',
  },
  {
    slug: 'competitive-research',
    name: 'Competitive Research',
    description:
      'Daily 6 AM. Refreshes the ops.competitors corpus — pricing, feature shifts, market positioning changes.',
    agent_type: 'routine',
    schedule: 'Daily 6:00 AM',
    external_link: 'https://claude.ai/code/routines',
    owner: 'jonathan',
    expected_max_gap_minutes: 60 * 30,
    tags: ['research', 'competitors', 'routine', 'remote'],
    backfill_actor_name: 'competitive-research',
  },
  {
    slug: 'marketing-strategist',
    name: 'HeyHenry Marketing Strategist',
    description:
      'Tactical marketing brainstorms — content, launch, acquisition only (strategic moves go to business-scout). Writes 3-5 ideas to ops.ideas tagged marketing-scout + email digest via ops_email_send.',
    agent_type: 'routine',
    schedule: 'TBD',
    external_link: 'https://claude.ai/code/routines',
    owner: 'jonathan',
    expected_max_gap_minutes: 60 * 30,
    tags: ['marketing', 'brainstorm', 'routine', 'remote'],
    backfill_actor_name: null,
  },
  // Other Local routines (Friday memory synthesis, feature-matrix-refresh)
  // belong to HenryOS, not HeyHenry — out of scope for this registry.
];

async function upsertAgents() {
  console.log(`Upserting ${FLEET.length} agents...`);
  for (const a of FLEET) {
    await sql`
      INSERT INTO ops.agents
        (slug, name, description, agent_type, schedule, external_link, owner,
         status, expected_max_gap_minutes, tags)
      VALUES
        (${a.slug}, ${a.name}, ${a.description}, ${a.agent_type}, ${a.schedule},
         ${a.external_link}, ${a.owner}, 'active', ${a.expected_max_gap_minutes},
         ${a.tags})
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        agent_type = EXCLUDED.agent_type,
        schedule = EXCLUDED.schedule,
        external_link = EXCLUDED.external_link,
        owner = EXCLUDED.owner,
        expected_max_gap_minutes = EXCLUDED.expected_max_gap_minutes,
        tags = EXCLUDED.tags,
        updated_at = now()
    `;
    console.log(`  ✓ ${a.slug}`);
  }
}

async function backfillFromWorklog(daysBack = 30) {
  console.log(`Backfilling agent_runs from ops.worklog_entries (last ${daysBack}d)...`);
  let inserted = 0;
  for (const a of FLEET) {
    if (!a.backfill_actor_name) continue;
    // Find worklog entries authored by this agent.
    const entries = await sql`
      SELECT id, created_at, title, body, tags
      FROM ops.worklog_entries
      WHERE actor_name = ${a.backfill_actor_name}
        AND actor_type = 'agent'
        AND archived_at IS NULL
        AND created_at >= now() - (${daysBack} || ' days')::interval
      ORDER BY created_at ASC
    `;
    if (entries.length === 0) continue;

    const { rows: agentRows } = await sql`
      SELECT id FROM ops.agents WHERE slug = ${a.slug}
    `.then((rows) => ({ rows }));
    const agentId = agentRows[0]?.id;
    if (!agentId) continue;

    for (const e of entries) {
      // Dedup: skip if a run with the same started_at already exists.
      const dup = await sql`
        SELECT id FROM ops.agent_runs
        WHERE agent_id = ${agentId} AND started_at = ${e.created_at}
        LIMIT 1
      `;
      if (dup.length > 0) continue;

      await sql`
        INSERT INTO ops.agent_runs
          (agent_id, started_at, finished_at, outcome, trigger, summary, payload)
        VALUES
          (${agentId}, ${e.created_at}, ${e.created_at}, 'success', 'backfill',
           ${(e.title ?? '').slice(0, 500)},
           ${{ source: 'worklog', worklog_id: e.id, body: e.body ?? null }})
      `;
      inserted += 1;
    }
    console.log(`  ✓ ${a.slug}: backfilled ${entries.length} entries`);
  }
  console.log(`Backfill complete: ${inserted} agent_runs inserted.`);
}

async function backfillFromAuditLog(daysBack = 30) {
  console.log(`Backfilling routine runs from ops.audit_log (last ${daysBack}d)...`);
  // OAuth-authed routine calls land with key_id=NULL but show up in
  // audit_log; we cluster by day per routine to approximate "one run per
  // day" since routines fire once daily. Anything finer-grained needs the
  // routine prompt updated to call agent_run_start/finish explicitly.
  const routinesToBackfill = FLEET.filter((a) => a.agent_type === 'routine');
  let inserted = 0;
  for (const r of routinesToBackfill) {
    // Most routines call distinctive tool sets — heuristic match by tool path.
    let pathPattern;
    if (r.slug === 'doc-writer') pathPattern = '%docs_%';
    else if (r.slug === 'dispatcher') pathPattern = '%ops_activity_digest%';
    else if (r.slug === 'helpdesk-triage') pathPattern = '%kanban_card_comment%';
    else continue; // scouts use generic write paths; skip backfill

    const days = await sql`
      SELECT date_trunc('day', occurred_at)::timestamptz AS day,
             count(*) AS calls,
             min(occurred_at) AS first_call,
             max(occurred_at) AS last_call
      FROM ops.audit_log
      WHERE path LIKE ${pathPattern}
        AND occurred_at >= now() - (${daysBack} || ' days')::interval
        AND status = 200
      GROUP BY date_trunc('day', occurred_at)
      ORDER BY day ASC
    `;

    const agentRows = await sql`SELECT id FROM ops.agents WHERE slug = ${r.slug}`;
    const agentId = agentRows[0]?.id;
    if (!agentId) continue;

    for (const d of days) {
      const dup = await sql`
        SELECT id FROM ops.agent_runs
        WHERE agent_id = ${agentId} AND started_at = ${d.first_call}
        LIMIT 1
      `;
      if (dup.length > 0) continue;
      await sql`
        INSERT INTO ops.agent_runs
          (agent_id, started_at, finished_at, outcome, trigger, summary, payload)
        VALUES
          (${agentId}, ${d.first_call}, ${d.last_call}, 'success', 'backfill',
           ${`${d.calls} MCP calls`},
           ${{ source: 'audit_log', day: d.day, calls: Number(d.calls) }})
      `;
      inserted += 1;
    }
    console.log(`  ✓ ${r.slug}: ${days.length} day-aggregated runs`);
  }
  console.log(`Audit-log backfill complete: ${inserted} runs inserted.`);
}

async function main() {
  try {
    await upsertAgents();
    await backfillFromWorklog(30);
    await backfillFromAuditLog(30);
    const summary = await sql`
      SELECT computed_status, count(*)::int AS n
      FROM ops.agent_health
      GROUP BY computed_status
      ORDER BY computed_status
    `;
    console.log('\nAgent health summary:');
    for (const s of summary) console.log(`  ${s.computed_status}: ${s.n}`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
