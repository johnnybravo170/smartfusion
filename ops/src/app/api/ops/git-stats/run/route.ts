import { type NextRequest, NextResponse } from 'next/server';
import { withAgentRun } from '@/lib/agents';
import { createServiceClient } from '@/lib/supabase';

/**
 * Daily git-stats refresh. Triggered by Vercel Cron at 01:00 UTC.
 *
 * Auth matches /api/ops/maintenance/run: accept Vercel cron's
 * x-vercel-cron-signature, or a matching CRON_SECRET bearer token.
 *
 * Pulls the last 2 days of commits from the GitHub REST API and UPSERTs
 * ops.git_daily_stats. 2 days so today refreshes all day and yesterday
 * gets finalized after the UTC rollover.
 *
 * Repo is parameterized via GITHUB_REPO (e.g. "johnnybravo170/heyhenry").
 * GITHUB_TOKEN is optional — unauthenticated GitHub allows 60 req/hr which
 * is plenty for this, but a token raises the cap and also grants access to
 * private repos.
 */

export const maxDuration = 60;

type Commit = {
  sha: string;
  commit: { author: { name: string; date: string } };
};

type CommitDetail = {
  stats?: { additions: number; deletions: number };
  commit: { author: { name: string; date: string } };
};

function dayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

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

export async function GET(req: NextRequest) {
  const fromVercelCron = req.headers.get('x-vercel-cron-signature') !== null;
  if (!fromVercelCron) {
    const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const expected = process.env.CRON_SECRET;
    if (!expected || bearer !== expected) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const result = await withAgentRun(
    { slug: 'git-stats', trigger: fromVercelCron ? 'schedule' : 'manual' },
    async (report) => {
      const r = await runGitStats();
      report({
        outcome: 'success',
        items_scanned: r.commits,
        items_acted: r.days_updated,
        summary: `${r.commits} commits across ${r.days_updated} days`,
        payload: r,
      });
      return r;
    },
  );
  return NextResponse.json(result);
}

async function runGitStats() {
  const repo = process.env.GITHUB_REPO ?? 'johnnybravo170/heyhenry';
  const token = process.env.GITHUB_TOKEN ?? null;

  // Window: yesterday 00:00Z through now.
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setUTCHours(0, 0, 0, 0);
  windowStart.setUTCDate(windowStart.getUTCDate() - 1);

  // List commits in window (paginate up to a few hundred).
  const perPage = 100;
  let page = 1;
  const commits: Commit[] = [];
  // Cap at 5 pages (500 commits) as a safety limit.
  while (page <= 5) {
    const url = `https://api.github.com/repos/${repo}/commits?since=${windowStart.toISOString()}&until=${now.toISOString()}&per_page=${perPage}&page=${page}`;
    const batch = await gh<Commit[]>(url, token);
    commits.push(...batch);
    if (batch.length < perPage) break;
    page += 1;
  }

  // Aggregate by day. LOC needs per-commit stats — fetch detail in parallel
  // with a small concurrency cap.
  type Agg = {
    commit_count: number;
    loc_added: number;
    loc_deleted: number;
    contributors: Set<string>;
  };
  const byDay = new Map<string, Agg>();
  function bucket(day: string): Agg {
    let a = byDay.get(day);
    if (!a) {
      a = { commit_count: 0, loc_added: 0, loc_deleted: 0, contributors: new Set() };
      byDay.set(day, a);
    }
    return a;
  }

  // Seed both days so we always upsert both, even if empty.
  const todayKey = now.toISOString().slice(0, 10);
  const yesterdayKey = dayKey(windowStart.toISOString());
  bucket(todayKey);
  bucket(yesterdayKey);

  // Fetch details sequentially in small chunks to avoid secondary-rate-limit.
  const CONCURRENCY = 5;
  for (let i = 0; i < commits.length; i += CONCURRENCY) {
    const chunk = commits.slice(i, i + CONCURRENCY);
    const details = await Promise.all(
      chunk.map((c) =>
        gh<CommitDetail>(`https://api.github.com/repos/${repo}/commits/${c.sha}`, token).catch(
          () => null,
        ),
      ),
    );
    for (let j = 0; j < chunk.length; j++) {
      const c = chunk[j];
      const d = details[j];
      const day = dayKey(c.commit.author.date);
      const agg = bucket(day);
      agg.commit_count += 1;
      if (c.commit.author.name) agg.contributors.add(c.commit.author.name);
      if (d?.stats) {
        agg.loc_added += d.stats.additions;
        agg.loc_deleted += d.stats.deletions;
      }
    }
  }

  const service = createServiceClient();
  let daysUpdated = 0;
  for (const [day, agg] of byDay) {
    const { error } = await service
      .schema('ops')
      .from('git_daily_stats')
      .upsert(
        {
          day,
          commit_count: agg.commit_count,
          loc_added: agg.loc_added,
          loc_deleted: agg.loc_deleted,
          contributors: [...agg.contributors],
          last_refreshed: new Date().toISOString(),
        },
        { onConflict: 'day' },
      );
    if (!error) daysUpdated += 1;
  }

  return { ok: true, days_updated: daysUpdated, commits: commits.length };
}
