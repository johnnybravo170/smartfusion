import { GoogleGenAI } from '@google/genai';
import { type NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import {
  type ActorCtx,
  archiveCard,
  commentCard,
  createCard,
  listCards,
  moveCard,
  updateCard,
} from '@/server/ops-services/kanban';

/**
 * Hourly feedback triage. Triggered by Vercel Cron OR manual run with CRON_SECRET.
 *
 * Reads dev-board cards still sitting in `backlog` with the `inbox-from-app` tag
 * (Jonathan's in-app feedback button parks cards there). Asks Gemini Flash to
 * classify each one, then deterministically applies the action:
 *   - noise   → archive
 *   - dedup   → comment on the dedup target with a link to the new card, archive new
 *   - keep    → move to `todo`, append a triage block to the body with severity + repro hint
 *
 * Why not Anthropic routines: Anthropic caps free routines at 15/day; this needs
 * to run every hour. Gemini Flash via Google credits is effectively free for the
 * volume we expect (one operator submitting feedback ad hoc).
 *
 * Why not SMS the operator: Jonathan is currently the sole submitter — he doesn't
 * need to be SMSed about something he just sent. The point is to surface it for
 * Claude in the next session.
 */

export const maxDuration = 120;

const ACTOR: ActorCtx = {
  actorType: 'agent',
  actorName: 'feedback-triage',
  keyId: null,
  adminUserId: null,
};

type Verdict = {
  action: 'keep' | 'noise' | 'dedup';
  severity: 'low' | 'med' | 'high';
  category: 'bug' | 'ux' | 'question' | 'feature-request' | 'noise';
  dedup_card_id: string | null;
  repro_hint: string;
  reason: string;
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

  const inbox = await listCards({
    boardSlug: 'dev',
    column: 'backlog',
    tags: ['inbox-from-app'],
    includeBlocked: true,
    limit: 50,
  });

  const actions: Array<{ id: string; verdict: Verdict | null; applied: string; error?: string }> =
    [];

  if (inbox.length > 0) {
    // Pull existing todo cards once for dedup context.
    const existingTodo = await listCards({
      boardSlug: 'dev',
      column: 'todo',
      includeBlocked: true,
      limit: 200,
    });
    const dedupCandidates = existingTodo.map((c) => ({
      id: c.id as string,
      title: c.title as string,
    }));

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'GEMINI_API_KEY not set' }, { status: 500 });
    }
    const ai = new GoogleGenAI({ apiKey });

    await processInbox(ai, inbox, dedupCandidates, actions);
  }

  // Sentry incidents always run, even when feedback inbox is empty.
  const incidentActions = await surfaceOpenIncidents();

  const promoted = actions.filter((a) => a.applied === 'promoted').length;
  const archivedCount = actions.filter((a) => a.applied === 'archived').length;
  const dedupedCount = actions.filter((a) => a.applied === 'deduped').length;
  const failed = actions.filter((a) => a.applied === 'failed' || a.applied === 'skipped').length;
  const incidentsSpawned = incidentActions.filter((a) => a.applied === 'spawned').length;

  // Only worklog when something happened — empty runs would spam the feed.
  if (actions.length > 0 || incidentsSpawned > 0) {
    const service = createServiceClient();
    await service
      .schema('ops')
      .from('worklog_entries')
      .insert({
        actor_type: 'agent',
        actor_name: 'feedback-triage',
        title: `Triage: ${promoted} promoted, ${archivedCount} archived, ${dedupedCount} deduped, ${incidentsSpawned} incidents surfaced${failed ? `, ${failed} failed` : ''}`,
        body: JSON.stringify({ actions, incidentActions }, null, 2),
        category: 'ops',
        site: 'ops',
        tags: ['triage', 'feedback'],
      });
  }

  return NextResponse.json({
    ok: true,
    triaged: inbox.length,
    actions,
    incidents_surfaced: incidentsSpawned,
    incident_actions: incidentActions,
  });
}

async function processInbox(
  ai: GoogleGenAI,
  inbox: Awaited<ReturnType<typeof listCards>>,
  dedupCandidates: Array<{ id: string; title: string }>,
  actions: Array<{ id: string; verdict: Verdict | null; applied: string; error?: string }>,
) {
  for (const card of inbox) {
    const cardId = card.id as string;
    let verdict: Verdict | null = null;

    try {
      verdict = await classify(ai, card, dedupCandidates);
    } catch (e) {
      actions.push({
        id: cardId,
        verdict: null,
        applied: 'skipped',
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    try {
      if (verdict.action === 'noise') {
        await archiveCard(ACTOR, cardId);
        await commentCard(ACTOR, cardId, `**Auto-triage:** archived as noise. ${verdict.reason}`);
        actions.push({ id: cardId, verdict, applied: 'archived' });
        continue;
      }

      if (verdict.action === 'dedup' && verdict.dedup_card_id) {
        const target = verdict.dedup_card_id;
        await commentCard(
          ACTOR,
          target,
          `**Auto-triage:** linked duplicate from in-app feedback (card \`${cardId}\`).\n\n> ${(card.title as string).replace(/\n/g, ' ')}\n\n${verdict.reason}`,
        );
        await commentCard(
          ACTOR,
          cardId,
          `**Auto-triage:** marked as duplicate of \`${target}\`. ${verdict.reason}`,
        );
        await archiveCard(ACTOR, cardId);
        actions.push({ id: cardId, verdict, applied: 'deduped' });
        continue;
      }

      // keep → move to todo + augment body
      const newBody = augmentBody(card.body as string | null, verdict);
      await updateCard(ACTOR, cardId, { body: newBody });
      await moveCard(ACTOR, cardId, 'todo');
      actions.push({ id: cardId, verdict, applied: 'promoted' });
    } catch (e) {
      actions.push({
        id: cardId,
        verdict,
        applied: 'failed',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

async function surfaceOpenIncidents(): Promise<
  Array<{ incident_id: string; applied: string; card_id?: string; error?: string }>
> {
  const service = createServiceClient();

  const { data: openIncidents, error: incErr } = await service
    .schema('ops')
    .from('incidents')
    .select('id, source, severity, title, body, context, created_at')
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(50);
  if (incErr) throw new Error(`incidents query failed: ${incErr.message}`);
  if (!openIncidents || openIncidents.length === 0) return [];

  const incidentIds = openIncidents.map((i) => i.id as string);
  const { data: existingCards } = await service
    .schema('ops')
    .from('kanban_cards')
    .select('related_id')
    .eq('related_type', 'incident')
    .in('related_id', incidentIds)
    .is('archived_at', null);
  const surfacedIds = new Set((existingCards ?? []).map((c) => c.related_id as string));

  const results: Array<{ incident_id: string; applied: string; card_id?: string; error?: string }> =
    [];

  for (const inc of openIncidents) {
    const incId = inc.id as string;
    if (surfacedIds.has(incId)) {
      results.push({ incident_id: incId, applied: 'skipped' });
      continue;
    }

    try {
      const sev = (inc.severity as string) ?? 'med';
      const title = `[${sev}] ${inc.title}`.slice(0, 500);
      const body = `**Auto-surfaced from Sentry incident** \`${incId}\`

Severity: \`${sev}\` · Source: \`${inc.source}\` · Opened: ${new Date(inc.created_at as string).toISOString()}

${(inc.body as string | null) ?? '(no body)'}

[Open incident in ops](https://ops.heyhenry.io/incidents/${incId})`;

      const { id: cardId } = await createCard(ACTOR, {
        boardSlug: 'dev',
        column: 'todo',
        title,
        body,
        tags: ['triage:claude', 'from-sentry'],
        related_type: 'incident',
        related_id: incId,
      });
      results.push({ incident_id: incId, applied: 'spawned', card_id: cardId });
    } catch (e) {
      results.push({
        incident_id: incId,
        applied: 'failed',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return results;
}

async function classify(
  ai: GoogleGenAI,
  card: Awaited<ReturnType<typeof listCards>>[number],
  dedupCandidates: Array<{ id: string; title: string }>,
): Promise<Verdict> {
  const prompt = `You are triaging a single in-app feedback report for HeyHenry, a contractor SaaS.

The submitter is the operator (the one who runs HeyHenry). Your job: classify it so it surfaces correctly for Claude in the next coding session.

Return strict JSON matching this shape — no preamble, no markdown fences:
{
  "action": "keep" | "noise" | "dedup",
  "severity": "low" | "med" | "high",
  "category": "bug" | "ux" | "question" | "feature-request" | "noise",
  "dedup_card_id": null | "<uuid from candidates list>",
  "repro_hint": "one-sentence reproduction or starting point for fixing it",
  "reason": "one short sentence explaining your call"
}

Rules:
- "noise" only for accidental empty / test / nonsense submissions. When in doubt, "keep".
- "dedup" only if a candidate's title is clearly the same issue. Otherwise "keep".
- "high" severity = production breakage, data loss, security. "med" = real UX bug. "low" = nit/polish/feature idea.

CARD TITLE: ${card.title}

CARD BODY:
${(card.body as string | null) ?? '(empty)'}

EXISTING TODO CARDS (potential dedup targets):
${dedupCandidates.map((c) => `- ${c.id}: ${c.title}`).join('\n') || '(none)'}`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { responseMimeType: 'application/json', temperature: 0.1 },
  });

  const raw = response.text ?? '';
  const parsed = JSON.parse(raw) as Verdict;

  // Guardrail: Gemini may hallucinate a dedup id not in our list.
  if (parsed.action === 'dedup') {
    const valid = dedupCandidates.some((c) => c.id === parsed.dedup_card_id);
    if (!valid) {
      parsed.action = 'keep';
      parsed.dedup_card_id = null;
    }
  }
  return parsed;
}

function augmentBody(original: string | null, v: Verdict): string {
  const base = original ?? '';
  const block = `

---

**Auto-triage** (${new Date().toISOString().slice(0, 10)})

- Severity: \`${v.severity}\`
- Category: \`${v.category}\`
- Repro hint: ${v.repro_hint}
- Reason: ${v.reason}`;
  return base + block;
}
