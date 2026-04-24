/**
 * Read-only views over ops.git_daily_stats. All queries are cheap — the
 * table holds one row per day, so even "all time" is a few hundred rows.
 */
import { createServiceClient } from '@/lib/supabase';

export type DailyStat = {
  day: string;
  commit_count: number;
  loc_added: number;
  loc_deleted: number;
  contributors: string[];
};

async function fetchRange(fromDay: string): Promise<DailyStat[]> {
  const service = createServiceClient();
  const { data, error } = await service
    .schema('ops')
    .from('git_daily_stats')
    .select('day, commit_count, loc_added, loc_deleted, contributors')
    .gte('day', fromDay)
    .order('day', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    day: r.day as string,
    commit_count: (r.commit_count as number) ?? 0,
    loc_added: (r.loc_added as number) ?? 0,
    loc_deleted: (r.loc_deleted as number) ?? 0,
    contributors: (r.contributors as string[] | null) ?? [],
  }));
}

async function fetchAll(): Promise<DailyStat[]> {
  const service = createServiceClient();
  const { data, error } = await service
    .schema('ops')
    .from('git_daily_stats')
    .select('day, commit_count, loc_added, loc_deleted, contributors')
    .order('day', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    day: r.day as string,
    commit_count: (r.commit_count as number) ?? 0,
    loc_added: (r.loc_added as number) ?? 0,
    loc_deleted: (r.loc_deleted as number) ?? 0,
    contributors: (r.contributors as string[] | null) ?? [],
  }));
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoStr(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export type VanitySummary = {
  commitsToday: number;
  commitsThisWeek: number;
  commitsAllTime: number;
  locNetThisWeek: number;
  locNetAllTime: number;
  activeDaysThisMonth: number;
  hasData: boolean;
};

export async function getVanitySummary(): Promise<VanitySummary> {
  const all = await fetchAll();
  if (all.length === 0) {
    return {
      commitsToday: 0,
      commitsThisWeek: 0,
      commitsAllTime: 0,
      locNetThisWeek: 0,
      locNetAllTime: 0,
      activeDaysThisMonth: 0,
      hasData: false,
    };
  }
  const today = todayStr();
  const weekStart = daysAgoStr(6); // last 7 days inclusive
  const monthStart = daysAgoStr(29); // last 30 days inclusive
  let commitsToday = 0;
  let commitsThisWeek = 0;
  let commitsAllTime = 0;
  let locNetThisWeek = 0;
  let locNetAllTime = 0;
  let activeDaysThisMonth = 0;
  for (const r of all) {
    commitsAllTime += r.commit_count;
    locNetAllTime += r.loc_added - r.loc_deleted;
    if (r.day === today) commitsToday = r.commit_count;
    if (r.day >= weekStart) {
      commitsThisWeek += r.commit_count;
      locNetThisWeek += r.loc_added - r.loc_deleted;
    }
    if (r.day >= monthStart && r.commit_count > 0) activeDaysThisMonth += 1;
  }
  return {
    commitsToday,
    commitsThisWeek,
    commitsAllTime,
    locNetThisWeek,
    locNetAllTime,
    activeDaysThisMonth,
    hasData: true,
  };
}

export type StatsPageData = {
  last30: DailyStat[];
  topContributorsThisMonth: Array<{ name: string; commits: number }>;
  weeklyLoc: Array<{ weekStart: string; added: number; deleted: number }>;
  allTime: { commits: number; added: number; deleted: number; since: string | null };
  busiestDay: { day: string; commits: number } | null;
  longestStreak: { days: number; start: string; end: string } | null;
  hasData: boolean;
};

export async function getStatsPageData(): Promise<StatsPageData> {
  const all = await fetchAll();
  if (all.length === 0) {
    return {
      last30: [],
      topContributorsThisMonth: [],
      weeklyLoc: [],
      allTime: { commits: 0, added: 0, deleted: 0, since: null },
      busiestDay: null,
      longestStreak: null,
      hasData: false,
    };
  }
  const monthStart = daysAgoStr(29);
  const thirtyStart = daysAgoStr(29);
  const last30 = await fetchRange(thirtyStart);

  // Top contributors this month — one commit per author-day is the only
  // signal we store, so "commits" here means "days active" for that author.
  // Acceptable proxy; we aggregate by summing commit_count across days they
  // appear. Good enough for a vanity leaderboard.
  const contribDayCounts = new Map<string, number>();
  for (const r of all) {
    if (r.day < monthStart) continue;
    if (r.contributors.length === 0) continue;
    // Distribute that day's commits evenly across contributors (rough).
    const share = r.commit_count / r.contributors.length;
    for (const name of r.contributors) {
      contribDayCounts.set(name, (contribDayCounts.get(name) ?? 0) + share);
    }
  }
  const topContributorsThisMonth = [...contribDayCounts.entries()]
    .map(([name, commits]) => ({ name, commits: Math.round(commits) }))
    .sort((a, b) => b.commits - a.commits)
    .slice(0, 8);

  // Weekly LOC, last 12 weeks. Week buckets anchored at today-Nx7.
  const weeklyLoc: Array<{ weekStart: string; added: number; deleted: number }> = [];
  for (let w = 11; w >= 0; w--) {
    const end = new Date();
    end.setUTCHours(0, 0, 0, 0);
    end.setUTCDate(end.getUTCDate() - w * 7);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 6);
    const startStr = start.toISOString().slice(0, 10);
    const endStr = end.toISOString().slice(0, 10);
    let added = 0;
    let deleted = 0;
    for (const r of all) {
      if (r.day < startStr || r.day > endStr) continue;
      added += r.loc_added;
      deleted += r.loc_deleted;
    }
    weeklyLoc.push({ weekStart: startStr, added, deleted });
  }

  // All-time totals
  let allCommits = 0;
  let allAdded = 0;
  let allDeleted = 0;
  for (const r of all) {
    allCommits += r.commit_count;
    allAdded += r.loc_added;
    allDeleted += r.loc_deleted;
  }

  // Busiest day
  let busiestDay: { day: string; commits: number } | null = null;
  for (const r of all) {
    if (!busiestDay || r.commit_count > busiestDay.commits) {
      busiestDay = { day: r.day, commits: r.commit_count };
    }
  }

  // Longest streak of consecutive days with >= 1 commit.
  let longest: { days: number; start: string; end: string } | null = null;
  let curStart: string | null = null;
  let curLen = 0;
  let prevDay: string | null = null;
  for (const r of all) {
    if (r.commit_count > 0) {
      if (prevDay && isNextDay(prevDay, r.day)) {
        curLen += 1;
      } else {
        curStart = r.day;
        curLen = 1;
      }
      if (!longest || curLen > longest.days) {
        longest = { days: curLen, start: curStart ?? r.day, end: r.day };
      }
      prevDay = r.day;
    } else {
      prevDay = r.day;
      curStart = null;
      curLen = 0;
    }
  }

  return {
    last30,
    topContributorsThisMonth,
    weeklyLoc,
    allTime: {
      commits: allCommits,
      added: allAdded,
      deleted: allDeleted,
      since: all[0].day,
    },
    busiestDay,
    longestStreak: longest,
    hasData: true,
  };
}

function isNextDay(prev: string, next: string): boolean {
  const p = new Date(`${prev}T00:00:00Z`).getTime();
  const n = new Date(`${next}T00:00:00Z`).getTime();
  return n - p === 24 * 60 * 60 * 1000;
}
