/**
 * Daily auto help-doc writer.
 *
 * Pulls the last 24h of merged commits to main, decides which ones produced
 * operator-visible behavior, and drafts an operator-voiced help_doc per
 * change. Drafts always land with is_published=false — a human flips
 * publish via help_docs_publish after review.
 *
 * Pattern matches triage-feedback (Gemini Flash, JSON mode) + git-stats
 * (GitHub REST). Uses Gemini per the existing rule of thumb: Anthropic
 * routine cap (15/day) is too tight for an hourly/daily ops loop.
 *
 * Triggered by:
 *   - Vercel Cron (x-vercel-cron-signature). Schedule registered in
 *     ops/vercel.json.
 *   - Manual run with Authorization: Bearer ${CRON_SECRET}.
 *
 * Idempotent. Dedup is on `help_docs.source_commit` — re-running the cron
 * never produces a second draft for the same SHA.
 */

import { GoogleGenAI } from '@google/genai';
import { type NextRequest, NextResponse } from 'next/server';
import { contentHash, embedText } from '@/lib/embed';
import { createServiceClient } from '@/lib/supabase';

export const maxDuration = 300;

const ACTOR_NAME = 'help-doc-writer';
const MODEL = 'gemini-2.5-flash';
const LOOKBACK_HOURS = 24;

// Paths that imply operator-visible behavior. Cheap pre-filter before we
// pay an LLM call.
const USER_FACING_PATH_PREFIXES = [
  'src/app/(dashboard)/',
  'src/app/(public)/',
  'src/app/(worker)/',
  'src/app/(bookkeeper)/',
  'src/components/features/',
  'src/server/actions/',
];

// Files within those prefixes we still skip (tests, types, etc).
const PATH_NEGATIVE_REGEXES = [/\.test\.(ts|tsx)$/, /\.spec\.(ts|tsx)$/, /\.d\.ts$/];

// Conventional-commit prefixes we consider for help-doc generation.
// Refactors / chores / docs / tests don't change operator-visible behavior
// in a way that warrants a doc.
const TYPE_REGEX = /^(feat|fix)(\([^)]+\))?!?:/i;

// Squash-merge tail like "feat(x): blah (#123)" — extract PR number.
const PR_TAIL_REGEX = /\(#(\d+)\)\s*$/m;

type Commit = {
  sha: string;
  commit: { author: { name: string; date: string }; message: string };
};

type CommitDetail = {
  sha: string;
  commit: { message: string; author: { name: string; date: string } };
  files?: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>;
};

type DocVerdict =
  | {
      is_user_visible: true;
      title: string;
      summary: string;
      route: string | null;
      body: string;
      tags: string[];
      reason: string;
    }
  | {
      is_user_visible: false;
      reason: string;
    };

type Action = {
  sha: string;
  applied: 'drafted' | 'skipped' | 'failed';
  reason?: string;
  doc_id?: string;
  pr?: number | null;
};

async function gh<T>(url: string, token: string | null): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub ${res.status}: ${await res.text().catch(() => '')}`);
  }
  return (await res.json()) as T;
}

function isUserFacingFile(path: string): boolean {
  if (PATH_NEGATIVE_REGEXES.some((r) => r.test(path))) return false;
  return USER_FACING_PATH_PREFIXES.some((p) => path.startsWith(p));
}

function extractPrNumber(message: string): number | null {
  const m = message.match(PR_TAIL_REGEX);
  return m ? Number(m[1]) : null;
}

function commitFirstLine(message: string): string {
  return message.split('\n', 1)[0] ?? '';
}

export async function GET(req: NextRequest) {
  const fromVercelCron = req.headers.get('x-vercel-cron-signature') !== null;
  if (!fromVercelCron) {
    const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const expected = process.env.CRON_SECRET;
    if (!expected || bearer !== expected) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const repo = process.env.GITHUB_REPO ?? 'johnnybravo170/heyhenry';
  const ghToken = process.env.GITHUB_TOKEN ?? null;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'GEMINI_API_KEY not set' }, { status: 500 });
  }

  const now = new Date();
  const since = new Date(now.getTime() - LOOKBACK_HOURS * 3600_000);

  // 1. List recent commits on main.
  const commits = await gh<Commit[]>(
    `https://api.github.com/repos/${repo}/commits?sha=main&since=${since.toISOString()}&until=${now.toISOString()}&per_page=100`,
    ghToken,
  );

  // 2. Filter by conventional-commit type prefix.
  const candidates = commits.filter((c) => TYPE_REGEX.test(commitFirstLine(c.commit.message)));

  if (candidates.length === 0) {
    return NextResponse.json({ ok: true, scanned: commits.length, drafted: 0, actions: [] });
  }

  // 3. Dedup against existing help_docs (source_commit).
  const service = createServiceClient();
  const shas = candidates.map((c) => c.sha);
  const { data: existing } = await service
    .from('help_docs')
    .select('source_commit')
    .in('source_commit', shas);
  const seen = new Set((existing ?? []).map((r) => r.source_commit as string));
  const todo = candidates.filter((c) => !seen.has(c.sha));

  if (todo.length === 0) {
    return NextResponse.json({
      ok: true,
      scanned: commits.length,
      candidates: candidates.length,
      drafted: 0,
      actions: [],
      note: 'all candidate commits already have a draft',
    });
  }

  // 4. For each candidate, fetch detail + decide + draft.
  const ai = new GoogleGenAI({ apiKey });
  const actions: Action[] = [];
  for (const c of todo) {
    let detail: CommitDetail;
    try {
      detail = await gh<CommitDetail>(
        `https://api.github.com/repos/${repo}/commits/${c.sha}`,
        ghToken,
      );
    } catch (e) {
      actions.push({
        sha: c.sha,
        applied: 'failed',
        reason: `gh fetch: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    const userFacingFiles = (detail.files ?? []).filter((f) => isUserFacingFile(f.filename));
    if (userFacingFiles.length === 0) {
      actions.push({ sha: c.sha, applied: 'skipped', reason: 'no user-facing files touched' });
      continue;
    }

    let verdict: DocVerdict;
    try {
      verdict = await classify(ai, detail, userFacingFiles);
    } catch (e) {
      actions.push({
        sha: c.sha,
        applied: 'failed',
        reason: `classify: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    if (!verdict.is_user_visible) {
      actions.push({ sha: c.sha, applied: 'skipped', reason: verdict.reason });
      continue;
    }

    // Insert draft.
    const pr = extractPrNumber(detail.commit.message);
    try {
      const { data: doc, error: insertErr } = await service
        .from('help_docs')
        .insert({
          actor_type: 'agent',
          actor_name: ACTOR_NAME,
          title: verdict.title,
          summary: verdict.summary,
          body: verdict.body,
          route: verdict.route,
          tags: verdict.tags ?? [],
          audience: 'operator',
          is_published: false,
          source_pr: pr,
          source_commit: c.sha,
        })
        .select('id')
        .single();
      if (insertErr || !doc) throw new Error(insertErr?.message ?? 'insert failed');

      // Embed best-effort.
      try {
        const text = `${verdict.title}\n\n${verdict.body}`;
        const [vector, hash] = await Promise.all([embedText(text), contentHash(text)]);
        await service.from('help_doc_embeddings').insert({
          doc_id: doc.id,
          embedding: vector,
          content_hash: hash,
        });
        await service
          .from('help_docs')
          .update({ embedding_updated_at: new Date().toISOString() })
          .eq('id', doc.id);
      } catch (embedErr) {
        // Doc is saved; embedding failure shouldn't fail the draft. The
        // doc just won't be searchable until re-embedded.
        actions.push({
          sha: c.sha,
          applied: 'drafted',
          doc_id: doc.id as string,
          pr,
          reason: `embed failed: ${embedErr instanceof Error ? embedErr.message : String(embedErr)}`,
        });
        continue;
      }

      actions.push({ sha: c.sha, applied: 'drafted', doc_id: doc.id as string, pr });
    } catch (e) {
      actions.push({
        sha: c.sha,
        applied: 'failed',
        reason: `insert: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // 5. Worklog only when something happened.
  const drafted = actions.filter((a) => a.applied === 'drafted').length;
  const skipped = actions.filter((a) => a.applied === 'skipped').length;
  const failed = actions.filter((a) => a.applied === 'failed').length;

  if (drafted > 0 || failed > 0) {
    await service
      .schema('ops')
      .from('worklog_entries')
      .insert({
        actor_type: 'agent',
        actor_name: ACTOR_NAME,
        title: `Help-doc writer: ${drafted} drafted, ${skipped} skipped${failed ? `, ${failed} failed` : ''}`,
        body: JSON.stringify({ window_hours: LOOKBACK_HOURS, actions }, null, 2),
        category: 'ops',
        site: 'ops',
        tags: ['help-docs', 'doc-writer'],
      })
      .then(
        () => undefined,
        () => undefined,
      );
  }

  return NextResponse.json({
    ok: true,
    scanned: commits.length,
    candidates: candidates.length,
    drafted,
    skipped,
    failed,
    actions,
  });
}

// ─────────────────────────────────────────────────────────────────────
// Classification prompt — Gemini Flash, JSON mode.
//
// Two jobs in one call:
//   1. Decide if the change is operator-visible (vs internal-only).
//   2. If yes, draft an operator-voiced help doc.
//
// IMPORTANT: tone instructions are heavy. The default agent voice on this
// repo writes engineer-audience prose ("ai_extraction envelope mirrors
// project_memos.ai_extraction"). That's wrong here — the audience is a
// contractor running their business, not someone reading the codebase.
// ─────────────────────────────────────────────────────────────────────
async function classify(
  ai: GoogleGenAI,
  detail: CommitDetail,
  userFacingFiles: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>,
): Promise<DocVerdict> {
  const filesBlock = userFacingFiles
    .slice(0, 10) // cap files for prompt size
    .map((f) => {
      const head = `--- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions}) ---`;
      const patch = (f.patch ?? '').slice(0, 1500); // cap each patch
      return `${head}\n${patch}`;
    })
    .join('\n\n');

  const prompt = `You write operator-audience help documentation for HeyHenry, a SaaS used by independent contractors (renovation GCs, pressure-washing crews, tile installers) to run their business — quotes, jobs, invoices, expenses, scheduling, customer messaging.

You will be shown one merged Git commit (title, body, files changed with patches). Your job:

1. Decide if this commit produced behavior an OPERATOR (the contractor using HeyHenry) would notice. New page, new button, new form field, new flow, new automation triggering on their data, changed copy on a customer-facing email, fixed a visible bug. NOT operator-visible: refactors, internal helpers, tests, dependency bumps, schema-only migrations not yet wired up, performance fixes, type-only changes.

2. If user-visible, draft a help doc.

OUTPUT: JSON only, no prose. Schema:
{
  "is_user_visible": boolean,
  "reason": string,                              // 1 sentence; why visible or not
  "title"?: string,                              // sentence-case, ≤ 80 chars, action-oriented ("Send a referral by SMS")
  "summary"?: string,                            // ≤ 200 chars, one sentence
  "route"?: string | null,                       // canonical app path (e.g. "/referrals") or null for cross-cutting
  "tags"?: string[],                             // 2-5 lowercase short tags
  "body"?: string                                // markdown, operator voice, see examples
}

VOICE / STYLE for body:
- You're talking to a contractor. They don't care about implementation, schemas, or migration numbers. They want to know "how do I do this?" and "where do I find it?".
- Use second person ("you"). Imperative. Short paragraphs. Bulleted steps.
- Reference UI labels and routes the way the operator sees them ("On Refer & Earn (/referrals)…"), not internal table or function names.
- ≤ 1500 chars.

GOOD example body:
"""
**Send a referral invite by SMS**

You can now invite another contractor to HeyHenry by text instead of email.

1. Open **Refer & Earn** (the gift icon in your sidebar).
2. Under **Send an invite**, type their phone number into the **SMS** field. A 10-digit number works — we'll add the +1 for you.
3. Hit **Send**.

They'll get a one-line text with your referral link. The invite shows up in your **Referral history** so you can track whether they signed up.

If you'd rather email instead, that field is right above.
"""

BAD example body (engineer-audience — DO NOT WRITE LIKE THIS):
"""
The sendReferralSMSAction now mirrors sendReferralEmailAction. CASL category is response_to_request. The relatedType union on sendSms gained 'referral'. Migration 0197 adds referrals.referred_phone…
"""

If \`is_user_visible\` is false, only return { is_user_visible: false, reason: "..." }.

──────────────────────────────────
COMMIT
──────────────────────────────────
SHA: ${detail.sha}
Author: ${detail.commit.author.name} on ${detail.commit.author.date}

MESSAGE:
${detail.commit.message}

USER-FACING FILES CHANGED:
${filesBlock}`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { responseMimeType: 'application/json', temperature: 0.2 },
  });

  const raw = response.text ?? '';
  const parsed = JSON.parse(raw) as DocVerdict;

  // Guardrails — Gemini might omit fields when is_user_visible=true.
  if (parsed.is_user_visible) {
    if (!parsed.title || !parsed.summary || !parsed.body) {
      return {
        is_user_visible: false,
        reason: 'classifier marked user-visible but omitted required fields',
      };
    }
  }
  return parsed;
}
