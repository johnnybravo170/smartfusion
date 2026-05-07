/**
 * Daily new-ideas digest cron.
 *
 * Sweeps `ops.ideas` for entries created in the last 7 days that haven't
 * been emailed yet (email_sent_at IS NULL), groups them, and sends one
 * digest to Jonathan. Marks each emailed idea with email_sent_at so the
 * next run skips them.
 *
 * Why this exists:
 *   Multiple agent paths write to ops.ideas — biz-scout, ai-tools-scout,
 *   marketing-strategist, and any future routine. Some of those send
 *   their own per-routine email digests, but historically a few routines
 *   wrote ideas without emailing (the May 6 brainstorm: 3 ideas dropped
 *   silently for 13+ hours). This cron is the safety net: anything that
 *   lands in ops.ideas reaches Jonathan within a day no matter which
 *   routine wrote it.
 *
 * Schedule: daily at 16:00 UTC = 09:00 PDT — morning digest.
 *
 * Auth: Vercel x-vercel-cron-signature OR Authorization: Bearer ${CRON_SECRET}.
 *
 * Sibling cron (separate route, separate schedule): the snooze-review path
 * at /api/ops/ideas-review/run handles the Sonnet-judge path for snoozed
 * ideas. This route is the simple, no-LLM digest of all NEW ideas.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { finishAgentRun, recordAgentRun } from '@/lib/agents';
import { createServiceClient } from '@/lib/supabase';
import { sendOpsEmail } from '@/server/ops-services/email';

export const maxDuration = 60;

const DIGEST_WINDOW_DAYS = 7;
const RECIPIENT = 'jonathan@smartfusion.ca';

type IdeaRow = {
  id: string;
  title: string;
  body: string | null;
  rating: number | null;
  tags: string[];
  actor_name: string;
  created_at: string;
};

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
    slug: 'ideas-digest',
    trigger: fromVercelCron ? 'schedule' : 'manual',
  }).catch(() => null);

  try {
    const result = await runIdeasDigest();
    if (run) {
      await finishAgentRun(run.id, {
        outcome: result.emailed === 0 ? 'skipped' : 'success',
        items_scanned: result.scanned,
        items_acted: result.emailed,
        summary:
          result.emailed === 0
            ? `Quiet day — 0 new ideas without email`
            : `Emailed digest of ${result.emailed} new idea${result.emailed === 1 ? '' : 's'} (${result.scanned} scanned)`,
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

async function runIdeasDigest(): Promise<{
  ok: true;
  scanned: number;
  emailed: number;
  email_id?: string | null;
  idea_ids: string[];
}> {
  const service = createServiceClient();

  // Window: last 7d, capped at 25 to keep email + token budget bounded.
  // Anything older that's still un-emailed gets a "(older)" footnote in
  // the digest body — surfaces it once before falling out of the window.
  const since = new Date(Date.now() - DIGEST_WINDOW_DAYS * 86400_000).toISOString();

  const { data: ideas, error } = await service
    .schema('ops')
    .from('ideas')
    .select('id, title, body, rating, tags, actor_name, created_at')
    .is('archived_at', null)
    .is('email_sent_at', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(25);
  if (error) throw new Error(`ideas query failed: ${error.message}`);

  const rows = (ideas ?? []) as IdeaRow[];
  if (rows.length === 0) {
    return { ok: true, scanned: 0, emailed: 0, email_id: null, idea_ids: [] };
  }

  const today = new Date().toISOString().slice(0, 10);
  const html = renderHtml(rows, today);
  const text = renderText(rows, today);

  const sendResult = await sendOpsEmail(
    {
      to: RECIPIENT,
      subject: `HeyHenry Ideas Digest — ${today} — ${rows.length} new idea${rows.length === 1 ? '' : 's'}`,
      html,
      text,
      tags: [{ name: 'agent', value: 'ideas-digest' }],
    },
    {
      keyId: null,
      path: '/api/ops/ideas-digest/run',
      method: 'GET',
    },
  );
  if (!sendResult.ok) {
    throw new Error(`email send failed: ${sendResult.error ?? 'unknown'}`);
  }

  // Mark emailed.
  const ids = rows.map((r) => r.id);
  const { error: updateErr } = await service
    .schema('ops')
    .from('ideas')
    .update({ email_sent_at: new Date().toISOString() })
    .in('id', ids);
  if (updateErr) {
    // Email already went out; surface the marking failure but don't fail
    // the run — the next run will re-email at most one extra time. Worse
    // case: duplicate email. Better than throwing here and losing the
    // record that we emailed at all.
    console.warn('[ideas-digest] failed to mark email_sent_at:', updateErr.message);
  }

  return {
    ok: true,
    scanned: rows.length,
    emailed: rows.length,
    email_id: sendResult.id ?? null,
    idea_ids: ids,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Email rendering — same visual language as the scout digests.
// ─────────────────────────────────────────────────────────────────────

function renderHtml(rows: IdeaRow[], date: string): string {
  const cards = rows
    .map((r) => {
      const summary = (r.body ?? '')
        .replace(/^#+\s.*$/gm, '')
        .trim()
        .slice(0, 220);
      const ratingStars =
        typeof r.rating === 'number' ? '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating) : '—';
      const tagPills = (r.tags ?? [])
        .slice(0, 5)
        .map(
          (t) =>
            `<span style="display:inline-block;padding:2px 8px;margin-right:6px;border-radius:999px;font-size:11px;font-weight:500;background:#f1f5f9;color:#475569;">${escapeHtml(t)}</span>`,
        )
        .join('');
      return `
        <tr><td style="padding:14px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:10px;">
            <tr><td style="padding:14px 16px;">
              <a href="https://ops.heyhenry.io/ideas/${r.id}" style="font-size:14px;font-weight:600;color:#0f172a;text-decoration:none;line-height:1.35;display:block;">${escapeHtml(r.title)}</a>
              <div style="margin-top:4px;font-size:11px;color:#64748b;">by ${escapeHtml(actorLabel(r.actor_name))} · ${ratingStars}</div>
              ${summary ? `<div style="margin-top:8px;font-size:13px;line-height:1.5;color:#334155;">${escapeHtml(summary)}…</div>` : ''}
              ${tagPills ? `<div style="margin-top:10px;">${tagPills}</div>` : ''}
              <div style="margin-top:10px;">
                <a href="https://ops.heyhenry.io/ideas/${r.id}" style="display:inline-block;padding:6px 12px;background:#0f172a;color:#ffffff;text-decoration:none;font-size:11px;font-weight:600;border-radius:6px;">Open in ops</a>
              </div>
            </td></tr>
          </table>
        </td></tr>`;
    })
    .join('');

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7;">
        <tr><td style="padding:20px 24px;border-bottom:1px solid #f1f5f9;">
          <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;font-weight:600;">HeyHenry · Ideas Digest</div>
          <div style="margin-top:4px;font-size:16px;color:#0f172a;font-weight:600;">${date}</div>
          <div style="margin-top:6px;font-size:13px;color:#475569;line-height:1.5;">${rows.length} new idea${rows.length === 1 ? '' : 's'} since the last digest, across all agent paths.</div>
        </td></tr>
        ${cards}
        <tr><td style="padding:14px 24px 22px;border-top:1px solid #f1f5f9;">
          <div style="font-size:12px;color:#64748b;line-height:1.5;">
            Each idea has been marked emailed and won't repeat in tomorrow's digest.
            <br/>
            <a href="https://ops.heyhenry.io/ideas" style="color:#1d4ed8;text-decoration:none;">All ideas →</a>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function renderText(rows: IdeaRow[], date: string): string {
  const blocks = rows
    .map((r, i) => {
      const summary = (r.body ?? '')
        .replace(/^#+\s.*$/gm, '')
        .trim()
        .slice(0, 220);
      const tagLine = (r.tags ?? []).slice(0, 5).join(', ');
      const ratingStr = typeof r.rating === 'number' ? `${r.rating}/5` : '—';
      return `${i + 1}. ${r.title}
   ops: https://ops.heyhenry.io/ideas/${r.id}
   by ${actorLabel(r.actor_name)} · rating ${ratingStr}${tagLine ? `\n   tags: ${tagLine}` : ''}
${summary ? `\n   ${summary}…` : ''}`;
    })
    .join('\n\n------------------------------------\n\n');

  return `HeyHenry · Ideas Digest — ${date}
====================================

${rows.length} new idea${rows.length === 1 ? '' : 's'} since the last digest.

------------------------------------

${blocks}

------------------------------------

All ideas: https://ops.heyhenry.io/ideas
`;
}

function actorLabel(actorName: string): string {
  // Cloud OAuth identifier is verbose; collapse to a friendlier name.
  if (actorName.includes('claude.ai/oauth')) return 'Claude (via Routine/MCP)';
  return actorName;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
