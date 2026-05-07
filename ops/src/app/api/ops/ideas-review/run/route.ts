/**
 * Snooze + Sonnet review cron.
 *
 * For each idea whose `remind_at` has come due, ask Claude Sonnet 4.6
 * whether the idea is actionable in current business context. Dispatch:
 *   actionable → email Jonathan (reasoning + suggested action + link),
 *                set review_status='actioned'.
 *   not_yet    → bump remind_at to re_snooze_to, status back to 'pending'.
 *   dismiss    → archive the idea, status='dismissed'.
 *
 * Shadow mode (env IDEAS_REVIEW_SHADOW=true) overrides dispatch for the
 * first 2 weeks: every verdict produces an email marked [SHADOW] so
 * Jonathan can sanity-check the agent's judgment before the auto-archive
 * path goes live. State changes still happen normally so the queue
 * doesn't pile up.
 *
 * Schedule: daily 17:00 UTC = 10:00 PDT — 1h after ideas-digest, comfortable
 * Anthropic budget. Adjust to hourly later if review volume warrants.
 *
 * Concurrency: optimistic-lock atomic flip pending → reviewing per row.
 * Self-heal at top: any row stuck in 'reviewing' for > 30min flips back
 * to 'pending' (means a previous run crashed mid-Sonnet-call).
 */

import Anthropic from '@anthropic-ai/sdk';
import { type NextRequest, NextResponse } from 'next/server';
import { finishAgentRun, recordAgentRun } from '@/lib/agents';
import { createServiceClient } from '@/lib/supabase';
import { sendOpsEmail } from '@/server/ops-services/email';

export const maxDuration = 300;

const SONNET_MODEL = 'claude-sonnet-4-6';
const RECIPIENT = 'jonathan@smartfusion.ca';
const MAX_PER_RUN = 10;
const MAX_RETRY_COUNT = 3;
const STUCK_REVIEWING_MINUTES = 30;
const RETRY_BACKOFF_MINUTES = 60;

type IdeaRow = {
  id: string;
  title: string;
  body: string | null;
  rating: number | null;
  tags: string[];
  remind_at: string;
  review_attempt_count: number;
  last_review_attempt_at: string | null;
};

type Verdict =
  | { verdict: 'actionable'; reasoning: string; suggested_action: string }
  | { verdict: 'not_yet'; reasoning: string; re_snooze_to: string }
  | { verdict: 'dismiss'; reasoning: string };

type Action =
  | { id: string; outcome: 'actioned'; verdict: Verdict; email_sent: boolean }
  | { id: string; outcome: 're_snoozed'; verdict: Verdict; new_remind_at: string }
  | { id: string; outcome: 'dismissed'; verdict: Verdict; email_sent: boolean }
  | { id: string; outcome: 'lock_lost' }
  | { id: string; outcome: 'errored'; error: string; attempt: number; backoff: boolean };

export async function GET(req: NextRequest) {
  const fromVercelCron = req.headers.get('x-vercel-cron-signature') !== null;
  if (!fromVercelCron) {
    const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const expected = process.env.CRON_SECRET;
    if (!expected || bearer !== expected) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const run = await recordAgentRun({
    slug: 'ideas-review',
    trigger: fromVercelCron ? 'schedule' : 'manual',
  }).catch(() => null);

  try {
    const result = await runIdeasReview();
    if (run) {
      const acted = result.actions.filter(
        (a) => a.outcome === 'actioned' || a.outcome === 're_snoozed' || a.outcome === 'dismissed',
      ).length;
      const errored = result.actions.filter((a) => a.outcome === 'errored').length;
      await finishAgentRun(run.id, {
        outcome: errored > 0 && acted === 0 ? 'failure' : acted === 0 ? 'skipped' : 'success',
        items_scanned: result.due_count,
        items_acted: acted,
        summary: summarize(result),
        payload: result,
      }).catch(() => undefined);
    }
    return NextResponse.json(result);
  } catch (e) {
    if (run) {
      await finishAgentRun(run.id, {
        outcome: 'failure',
        error: e instanceof Error ? e.message : String(e),
      }).catch(() => undefined);
    }
    throw e;
  }
}

function summarize(r: { actions: Action[]; due_count: number; shadow_mode: boolean }): string {
  const a = r.actions.reduce<Record<Action['outcome'], number>>(
    (acc, x) => {
      acc[x.outcome] = (acc[x.outcome] ?? 0) + 1;
      return acc;
    },
    { actioned: 0, re_snoozed: 0, dismissed: 0, lock_lost: 0, errored: 0 },
  );
  const parts = [
    a.actioned ? `${a.actioned} actioned` : null,
    a.re_snoozed ? `${a.re_snoozed} re-snoozed` : null,
    a.dismissed ? `${a.dismissed} dismissed` : null,
    a.errored ? `${a.errored} errored` : null,
  ].filter(Boolean);
  const tail = parts.length ? parts.join(', ') : 'no due ideas';
  return `${r.shadow_mode ? '[SHADOW] ' : ''}${tail} · ${r.due_count} due`;
}

async function runIdeasReview(): Promise<{
  ok: true;
  due_count: number;
  shadow_mode: boolean;
  actions: Action[];
}> {
  const shadow = (process.env.IDEAS_REVIEW_SHADOW ?? 'true').toLowerCase() === 'true';
  const service = createServiceClient();

  // Self-heal: any rows stuck in 'reviewing' beyond the stuck threshold
  // are likely from a previous run that crashed. Flip them back so they
  // get another shot.
  const stuckCutoff = new Date(Date.now() - STUCK_REVIEWING_MINUTES * 60_000).toISOString();
  await service
    .schema('ops')
    .from('ideas')
    .update({ review_status: 'pending' })
    .eq('review_status', 'reviewing')
    .lt('last_review_attempt_at', stuckCutoff);

  // Find due ideas. Backoff: skip rows whose last attempt was within the
  // last hour AND whose attempt_count is > 0 (errored retry path).
  const backoffCutoff = new Date(Date.now() - RETRY_BACKOFF_MINUTES * 60_000).toISOString();
  const { data: due, error: dueErr } = await service
    .schema('ops')
    .from('ideas')
    .select(
      'id, title, body, rating, tags, remind_at, review_attempt_count, last_review_attempt_at',
    )
    .is('archived_at', null)
    .eq('review_status', 'pending')
    .not('remind_at', 'is', null)
    .lte('remind_at', new Date().toISOString())
    .or(`last_review_attempt_at.is.null,last_review_attempt_at.lte.${backoffCutoff}`)
    .order('remind_at', { ascending: true })
    .limit(MAX_PER_RUN);
  if (dueErr) throw new Error(`due-ideas query failed: ${dueErr.message}`);

  const rows = (due ?? []) as IdeaRow[];
  if (rows.length === 0) {
    return { ok: true, due_count: 0, shadow_mode: shadow, actions: [] };
  }

  // Assemble shared business-context snapshot once per run — every verdict
  // sees the same ground truth.
  const context = await assembleContext();

  const actions: Action[] = [];
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const client = new Anthropic({ apiKey });

  for (const idea of rows) {
    // Atomic flip pending → reviewing. If 0 rows updated, another worker
    // grabbed it.
    const { data: locked, error: lockErr } = await service
      .schema('ops')
      .from('ideas')
      .update({
        review_status: 'reviewing',
        last_review_attempt_at: new Date().toISOString(),
      })
      .eq('id', idea.id)
      .eq('review_status', 'pending')
      .select('id')
      .maybeSingle();
    if (lockErr || !locked) {
      actions.push({ id: idea.id, outcome: 'lock_lost' });
      continue;
    }

    let verdict: Verdict;
    try {
      verdict = await callSonnet(client, idea, context);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const newAttempt = idea.review_attempt_count + 1;
      const finalErrored = newAttempt >= MAX_RETRY_COUNT;
      await service
        .schema('ops')
        .from('ideas')
        .update({
          review_status: finalErrored ? 'errored' : 'pending',
          review_attempt_count: newAttempt,
        })
        .eq('id', idea.id);
      actions.push({
        id: idea.id,
        outcome: 'errored',
        error: msg,
        attempt: newAttempt,
        backoff: !finalErrored,
      });
      continue;
    }

    // Dispatch — including shadow-mode email override.
    const action = await dispatch(service, idea, verdict, shadow);
    actions.push(action);
  }

  return { ok: true, due_count: rows.length, shadow_mode: shadow, actions };
}

// ─────────────────────────────────────────────────────────────────────
// Context assembly — pulled once per run.
// ─────────────────────────────────────────────────────────────────────

type BusinessContext = {
  roadmap: string;
  decisions: string;
  kanban_in_flight: string;
  recent_worklog: string;
};

async function assembleContext(): Promise<BusinessContext> {
  const service = createServiceClient();
  const since14d = new Date(Date.now() - 14 * 86400_000).toISOString();

  const [roadmapRes, decisionsRes, kanbanRes, worklogRes] = await Promise.all([
    service
      .schema('ops')
      .from('roadmap_items')
      .select('title, lane, status, priority, status_changed_at')
      .neq('status', 'archived')
      .order('priority', { ascending: false })
      .limit(20),
    service
      .schema('ops')
      .from('decisions')
      .select('title, hypothesis, status, created_at')
      .gte('created_at', since14d)
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .limit(10),
    service
      .schema('ops')
      .from('kanban_cards')
      .select('title, column_key, priority')
      .is('archived_at', null)
      .in('column_key', ['todo', 'doing', 'in_progress'])
      .order('priority', { ascending: false })
      .limit(20),
    service
      .schema('ops')
      .from('worklog_entries')
      .select('title, body, category, created_at')
      .gte('created_at', since14d)
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .limit(15),
  ]);

  return {
    roadmap: format(
      roadmapRes.data,
      (r: Record<string, unknown>) => `[${r.lane}] ${r.title} (priority: ${r.priority})`,
    ),
    decisions: format(
      decisionsRes.data,
      (r: Record<string, unknown>) =>
        `${r.title} — ${(r.hypothesis as string | null | undefined) ?? ''} (status: ${r.status})`,
    ),
    kanban_in_flight: format(
      kanbanRes.data,
      (r: Record<string, unknown>) => `[${r.column_key}] ${r.title}`,
    ),
    recent_worklog: format(
      worklogRes.data,
      (r: Record<string, unknown>) =>
        `[${(r.category as string | null | undefined) ?? '-'}] ${r.title}`,
    ),
  };
}

function format(rows: unknown, fn: (r: Record<string, unknown>) => string): string {
  if (!Array.isArray(rows) || rows.length === 0) return '(none)';
  return rows.map((r) => `- ${fn(r as Record<string, unknown>)}`).join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// Sonnet call — JSON-mode verdict.
// ─────────────────────────────────────────────────────────────────────

async function callSonnet(
  client: Anthropic,
  idea: IdeaRow,
  context: BusinessContext,
): Promise<Verdict> {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `You are a strategic advisor reviewing a deferred idea for Jonathan Boettcher (HeyHenry — voice-first AI assistant for contractors). Today is ${today}. The idea below was snoozed for re-evaluation today. Use the current business context to decide if it's actionable RIGHT NOW.

──────────────────
IDEA
──────────────────
Title: ${idea.title}
Original rating: ${idea.rating ?? 'unrated'}/5
Tags: ${(idea.tags ?? []).join(', ')}

${idea.body ?? '(no body)'}

──────────────────
CURRENT BUSINESS CONTEXT
──────────────────
ROADMAP (top 20 by priority):
${context.roadmap}

RECENT DECISIONS (last 14d):
${context.decisions}

KANBAN IN FLIGHT (todo/doing):
${context.kanban_in_flight}

RECENT WORKLOG (last 14d):
${context.recent_worklog}

──────────────────
YOUR JOB
──────────────────
Decide if this idea is actionable RIGHT NOW. Three verdicts:

- **actionable** — context supports doing this in the next 1-2 weeks. The idea aligns with current priorities, doesn't block on something stuck, and the original rationale still holds.
- **not_yet** — still good but blocked on timing, capital, a stuck card, or external dependency. Specify a re-snooze date 14-90 days out depending on what unblocks it.
- **dismiss** — current context has made this idea obsolete (decision contradicts it, market moved, scope absorbed elsewhere). Be decisive — Jonathan can override via the email.

Respond with JSON only, no prose. Schema:
{
  "verdict": "actionable" | "not_yet" | "dismiss",
  "reasoning": "2-3 sentence explanation, plain English, cite specific context items",
  "suggested_action": "specific 1-week first step, or null",
  "re_snooze_to": "YYYY-MM-DD, or null"
}`;

  const response = await client.messages.create({
    model: SONNET_MODEL,
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Sonnet returned no text block');
  }
  const raw = textBlock.text.trim();
  // Tolerate ```json fences
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error(`Sonnet response was not valid JSON: ${stripped.slice(0, 200)}`);
  }

  return normalizeVerdict(parsed);
}

function normalizeVerdict(v: unknown): Verdict {
  if (!v || typeof v !== 'object') throw new Error('verdict must be an object');
  const obj = v as Record<string, unknown>;
  const reasoning = String(obj.reasoning ?? '').trim();
  if (!reasoning) throw new Error('verdict missing reasoning');

  if (obj.verdict === 'actionable') {
    const action = String(obj.suggested_action ?? '').trim();
    if (!action) throw new Error('actionable verdict missing suggested_action');
    return { verdict: 'actionable', reasoning, suggested_action: action };
  }
  if (obj.verdict === 'not_yet') {
    const date = String(obj.re_snooze_to ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('not_yet verdict missing valid re_snooze_to (YYYY-MM-DD)');
    }
    return { verdict: 'not_yet', reasoning, re_snooze_to: date };
  }
  if (obj.verdict === 'dismiss') {
    return { verdict: 'dismiss', reasoning };
  }
  throw new Error(`unknown verdict: ${String(obj.verdict)}`);
}

// ─────────────────────────────────────────────────────────────────────
// Dispatch — apply state change + send email per the verdict.
// ─────────────────────────────────────────────────────────────────────

async function dispatch(
  service: ReturnType<typeof createServiceClient>,
  idea: IdeaRow,
  verdict: Verdict,
  shadow: boolean,
): Promise<Action> {
  const now = new Date().toISOString();
  const ideaUrl = `https://ops.heyhenry.io/ideas/${idea.id}`;

  if (verdict.verdict === 'actionable') {
    await service
      .schema('ops')
      .from('ideas')
      .update({ review_status: 'actioned', review_attempt_count: 0, updated_at: now })
      .eq('id', idea.id);
    const sent = await sendVerdictEmail({
      shadow,
      kind: 'actionable',
      idea,
      verdict,
      ideaUrl,
    });
    return { id: idea.id, outcome: 'actioned', verdict, email_sent: sent };
  }

  if (verdict.verdict === 'not_yet') {
    const newRemindAt = `${verdict.re_snooze_to}T15:00:00Z`;
    await service
      .schema('ops')
      .from('ideas')
      .update({
        review_status: 'pending',
        remind_at: newRemindAt,
        review_attempt_count: 0,
        updated_at: now,
      })
      .eq('id', idea.id);

    // not_yet doesn't email by default — quiet re-snooze. Shadow mode
    // overrides so Jonathan sees every verdict during the eval period.
    if (shadow) {
      await sendVerdictEmail({ shadow, kind: 'not_yet', idea, verdict, ideaUrl });
    }
    return { id: idea.id, outcome: 're_snoozed', verdict, new_remind_at: newRemindAt };
  }

  // dismiss — archive the idea.
  await service
    .schema('ops')
    .from('ideas')
    .update({
      review_status: 'dismissed',
      archived_at: shadow ? null : now, // Shadow: don't actually archive.
      review_attempt_count: 0,
      updated_at: now,
    })
    .eq('id', idea.id);

  // dismiss doesn't email by default — quiet archive. Shadow overrides.
  let sent = false;
  if (shadow) {
    sent = await sendVerdictEmail({ shadow, kind: 'dismiss', idea, verdict, ideaUrl });
  }
  return { id: idea.id, outcome: 'dismissed', verdict, email_sent: sent };
}

// ─────────────────────────────────────────────────────────────────────
// Email rendering for verdicts.
// ─────────────────────────────────────────────────────────────────────

async function sendVerdictEmail(args: {
  shadow: boolean;
  kind: 'actionable' | 'not_yet' | 'dismiss';
  idea: IdeaRow;
  verdict: Verdict;
  ideaUrl: string;
}): Promise<boolean> {
  const { shadow, kind, idea, verdict, ideaUrl } = args;
  const today = new Date().toISOString().slice(0, 10);
  const prefix = shadow ? '[SHADOW] ' : '';

  const subjectByKind: Record<typeof kind, string> = {
    actionable: `${prefix}Snoozed idea ready for action: ${idea.title}`,
    not_yet: `${prefix}Snoozed idea — re-snoozed (verdict: not_yet): ${idea.title}`,
    dismiss: `${prefix}Snoozed idea — dismissed: ${idea.title}`,
  };
  const subject = subjectByKind[kind].slice(0, 240);

  const verdictLabel: Record<typeof kind, string> = {
    actionable: 'Actionable now',
    not_yet: 'Not yet — re-snoozed',
    dismiss: 'Dismiss — context changed',
  };
  const verdictColor: Record<typeof kind, string> = {
    actionable: '#047857', // green
    not_yet: '#ca8a04', // amber
    dismiss: '#64748b', // slate
  };

  const actionBlock =
    verdict.verdict === 'actionable'
      ? `<div style="margin-top:14px;padding:12px 14px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;font-size:13px;line-height:1.55;color:#065f46;"><strong>Suggested action:</strong> ${escapeHtml(
          verdict.suggested_action,
        )}</div>`
      : verdict.verdict === 'not_yet'
        ? `<div style="margin-top:14px;font-size:12px;color:#64748b;">Re-snoozed to ${escapeHtml(verdict.re_snooze_to)}.</div>`
        : `<div style="margin-top:14px;font-size:12px;color:#64748b;">${shadow ? 'Would archive on real run.' : 'Idea has been archived.'}</div>`;

  const shadowBanner = shadow
    ? `<div style="padding:10px 24px;background:#fef3c7;border-bottom:1px solid #fde68a;font-size:12px;color:#92400e;"><strong>SHADOW MODE</strong> — verdicts are emailed for review only. Auto-archive is paused. Disable via IDEAS_REVIEW_SHADOW=false on the ops project.</div>`
    : '';

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7;">
        ${shadowBanner}
        <tr><td style="padding:20px 24px;border-bottom:1px solid #f1f5f9;">
          <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;font-weight:600;">HeyHenry · Snoozed Idea Review</div>
          <div style="margin-top:4px;font-size:16px;color:#0f172a;font-weight:600;">${escapeHtml(idea.title)}</div>
          <div style="margin-top:6px;font-size:11px;color:#64748b;">${today}</div>
        </td></tr>

        <tr><td style="padding:16px 24px;">
          <div>
            <span style="display:inline-block;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:600;background:${verdictColor[kind]}1a;color:${verdictColor[kind]};">${verdictLabel[kind]}</span>
          </div>
          <div style="margin-top:12px;font-size:13px;line-height:1.6;color:#334155;">${escapeHtml(verdict.reasoning)}</div>
          ${actionBlock}
          <div style="margin-top:18px;">
            <a href="${ideaUrl}" style="display:inline-block;padding:8px 14px;background:#0f172a;color:#ffffff;text-decoration:none;font-size:12px;font-weight:600;border-radius:6px;">Open idea in ops</a>
          </div>
        </td></tr>

        <tr><td style="padding:14px 24px 22px;border-top:1px solid #f1f5f9;">
          <div style="font-size:12px;color:#64748b;line-height:1.5;">
            Snoozed via <code>ideas_snooze</code>. The review cron runs daily at 17:00 UTC.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = `${prefix}HeyHenry · Snoozed Idea Review — ${today}

${idea.title}
${ideaUrl}

VERDICT: ${verdictLabel[kind]}

REASONING:
${verdict.reasoning}

${
  verdict.verdict === 'actionable'
    ? `SUGGESTED ACTION:\n${verdict.suggested_action}\n`
    : verdict.verdict === 'not_yet'
      ? `Re-snoozed to ${verdict.re_snooze_to}.\n`
      : `${shadow ? 'Would archive on real run.' : 'Idea archived.'}\n`
}
${shadow ? '\n⚠ SHADOW MODE — verdicts emailed for review only. Disable via IDEAS_REVIEW_SHADOW=false.\n' : ''}`;

  const result = await sendOpsEmail(
    {
      to: RECIPIENT,
      subject,
      html,
      text,
      tags: [
        { name: 'agent', value: 'ideas-review' },
        { name: 'verdict', value: kind },
        { name: 'shadow', value: shadow ? 'true' : 'false' },
      ],
    },
    {
      keyId: null,
      path: '/api/ops/ideas-review/run',
      method: 'GET',
    },
  );
  if (!result.ok) {
    console.warn('[ideas-review] verdict email failed:', result.error);
    return false;
  }
  return true;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
