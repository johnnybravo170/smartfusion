import { GoogleGenAI } from '@google/genai';
import { type NextRequest, NextResponse } from 'next/server';
import { finishAgentRun, recordAgentRun } from '@/lib/agents';
import { env } from '@/lib/env';
import { createServiceClient } from '@/lib/supabase';

/**
 * Weekly maintenance run. Triggered by Vercel Cron (Mondays 14:00 UTC,
 * 07:00 Pacific) OR manually by an agent with admin:maintenance scope.
 *
 * Auth model: Vercel Cron requests carry the header
 * `x-vercel-cron-signature` (signed with CRON_SECRET automatically). We
 * also accept an ops API key with admin:maintenance scope for manual runs.
 *
 * This endpoint has `maxDuration = 300` so the digest generation has room
 * to breathe.
 *
 * Tasks on each run:
 *   1. Archive stale worklog entries (>60 days, no references).
 *   2. Generate a weekly digest of the last 7 days and pin it as a new
 *      worklog entry (tagged weekly_digest, pinned).
 *
 * Phase 2 ships with these two. Deduping, cross-linking, priority re-ranking,
 * embedding refresh come in later phases.
 */

export const maxDuration = 300;

const STALE_WORKLOG_DAYS = 60;
const DIGEST_WINDOW_DAYS = 7;

export async function GET(req: NextRequest) {
  // Vercel Cron sends this header. Presence + the CRON_SECRET env-backed
  // auth Vercel does out-of-band is the gate. Outside of Vercel, require a
  // matching CRON_SECRET bearer token.
  const fromVercelCron = req.headers.get('x-vercel-cron-signature') !== null;
  if (!fromVercelCron) {
    const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const expected = process.env.CRON_SECRET;
    if (!expected || bearer !== expected) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const startedAt = new Date();
  const service = createServiceClient();

  // Record the run up-front so failures still leave a trace. We finalize
  // duration + counts at the end. ops.maintenance_runs predates the
  // ops.agents/agent_runs registry; we mirror into both so the dashboard
  // sees this agent live, while keeping maintenance-specific columns
  // (duration_ms, structured tasks) where existing readers expect them.
  const { data: runRow, error: runErr } = await service
    .schema('ops')
    .from('maintenance_runs')
    .insert({ started_at: startedAt.toISOString(), kind: 'weekly' })
    .select('id')
    .single();
  if (runErr || !runRow) {
    return NextResponse.json({ error: runErr?.message ?? 'run insert failed' }, { status: 500 });
  }
  const runId = runRow.id as string;

  // Mirror into ops.agent_runs for the agents dashboard. Best-effort —
  // a failure here shouldn't gate the maintenance work itself.
  const agentRun = await recordAgentRun({
    slug: 'maintenance-weekly',
    trigger: fromVercelCron ? 'schedule' : 'manual',
  }).catch((e) => {
    console.warn('[maintenance] agent_run open failed:', e);
    return null;
  });

  const tasks: Record<string, unknown> = {};

  // Task 1 — archive stale worklog entries.
  try {
    const cutoff = new Date(Date.now() - STALE_WORKLOG_DAYS * 86400_000).toISOString();
    const { data: archived, error } = await service
      .schema('ops')
      .from('worklog_entries')
      .update({ archived_at: new Date().toISOString() })
      .lt('created_at', cutoff)
      .is('archived_at', null)
      .not('tags', 'cs', '{pinned}')
      .select('id');
    tasks.archive_stale_worklog = {
      archived_count: archived?.length ?? 0,
      error: error?.message ?? null,
    };
  } catch (e) {
    tasks.archive_stale_worklog = { error: e instanceof Error ? e.message : String(e) };
  }

  // Task 2 — weekly digest via Gemini.
  try {
    const since = new Date(Date.now() - DIGEST_WINDOW_DAYS * 86400_000).toISOString();
    const [worklogRes, ideasRes, roadmapRes, decisionsRes] = await Promise.all([
      service
        .schema('ops')
        .from('worklog_entries')
        .select('actor_name, category, site, title, body, created_at')
        .gte('created_at', since)
        .is('archived_at', null)
        .order('created_at')
        .limit(400),
      service
        .schema('ops')
        .from('ideas')
        .select('title, body, status, rating, created_at')
        .gte('created_at', since)
        .is('archived_at', null)
        .order('created_at')
        .limit(200),
      service
        .schema('ops')
        .from('roadmap_items')
        .select('title, lane, status, priority, status_changed_at')
        .gte('status_changed_at', since)
        .neq('status', 'archived')
        .order('status_changed_at')
        .limit(200),
      service
        .schema('ops')
        .from('decisions')
        .select('title, hypothesis, status, created_at')
        .gte('created_at', since)
        .is('archived_at', null)
        .order('created_at')
        .limit(100),
    ]);

    const context = {
      worklog: worklogRes.data ?? [],
      ideas: ideasRes.data ?? [],
      roadmap_moves: roadmapRes.data ?? [],
      decisions: decisionsRes.data ?? [],
    };

    let digestMarkdown = '';
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? '' });
      const prompt = `You're summarizing the last 7 days of HeyHenry's platform-ops activity
for Jonathan (the operator). Be tight — less than 400 words. Sections:

**What shipped** — biggest worklog + roadmap movements.
**New ideas worth revisiting** — only the high-rated or interesting ones.
**Decisions** — new, progressed, or concluded.
**What's stuck** — anything stalled > 14 days (infer from dates).
**Suggested next moves** — 2-3 concrete actions.

Use headings and short bullets. Plaintext markdown only, no preamble.

Raw data (JSON):
${JSON.stringify(context).slice(0, 40000)}`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { temperature: 0.2 },
      });
      digestMarkdown = response.text ?? '';
    } catch (e) {
      digestMarkdown = `_Digest LLM call failed: ${e instanceof Error ? e.message : String(e)}_`;
    }

    const digestTitle = `Weekly digest — ${new Date().toLocaleDateString('en-CA')}`;
    const { error: digestErr } = await service
      .schema('ops')
      .from('worklog_entries')
      .insert({
        actor_type: 'agent',
        actor_name: 'ops:maintenance',
        title: digestTitle,
        body: digestMarkdown,
        category: 'digest',
        site: 'ops',
        tags: ['weekly_digest', 'pinned'],
      });
    tasks.weekly_digest = {
      digest_title: digestTitle,
      worklog_input_count: context.worklog.length,
      error: digestErr?.message ?? null,
    };

    // Best-effort email to Jonathan so he sees it in his inbox too.
    if (env.resendApiKey) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${env.resendApiKey}`,
          },
          body: JSON.stringify({
            from: env.alertsFromEmail,
            to: env.alertsToEmail,
            subject: digestTitle,
            html: `<pre style="font-family:system-ui,sans-serif;white-space:pre-wrap">${digestMarkdown.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] ?? c)}</pre><p style="color:#666;font-size:12px">See the full entry at <a href="https://ops.heyhenry.io/worklog">ops.heyhenry.io/worklog</a>.</p>`,
          }),
        });
      } catch {
        // non-fatal
      }
    }
  } catch (e) {
    tasks.weekly_digest = { error: e instanceof Error ? e.message : String(e) };
  }

  // Finalize run row.
  const finishedAt = new Date();
  await service
    .schema('ops')
    .from('maintenance_runs')
    .update({
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      tasks,
    })
    .eq('id', runId);

  // Finalize the agent_run mirror.
  if (agentRun) {
    const archive = (tasks.archive_stale_worklog ?? {}) as {
      archived_count?: number;
      error?: string | null;
    };
    const digest = (tasks.weekly_digest ?? {}) as {
      worklog_id?: string;
      error?: string | null;
    };
    const taskErrors = [archive.error, digest.error].filter(Boolean);
    const archived = archive.archived_count ?? 0;
    const summary =
      taskErrors.length > 0
        ? `Errored on ${taskErrors.length} task(s): ${taskErrors.join('; ').slice(0, 200)}`
        : `Archived ${archived} stale worklog entries; weekly digest ${digest.worklog_id ? 'pinned' : 'skipped'}`;
    await finishAgentRun(agentRun.id, {
      outcome: taskErrors.length > 0 ? 'failure' : 'success',
      items_acted: archived + (digest.worklog_id ? 1 : 0),
      summary,
      payload: { maintenance_run_id: runId, tasks },
      error: taskErrors.length > 0 ? taskErrors.join('; ') : undefined,
    }).catch((e) => {
      console.warn('[maintenance] agent_run close failed:', e);
    });
  }

  return NextResponse.json({ ok: true, run_id: runId, tasks });
}
