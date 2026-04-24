/**
 * Launch-progress service. Pure functions that read ops.kanban_cards
 * and derive V1 readiness signals. Used by both the /admin/launch
 * dashboard and the kanban_launch_* MCP tools.
 */
import { createServiceClient } from '@/lib/supabase';

export type RawCard = {
  id: string;
  board_id: string;
  title: string;
  column_key: string;
  tags: string[] | null;
  size_points: number | null;
  priority: number | null;
  assignee: string | null;
  blocked_by: string[] | null;
  done_at: string | null;
  created_at: string;
  updated_at: string;
};

const DEFAULT_POINTS = 3;

function isLaunchBlocker(c: RawCard): boolean {
  return (c.tags ?? []).includes('launch-blocker');
}

function isDone(c: RawCard): boolean {
  return c.column_key === 'done';
}

function pointsOf(c: RawCard): number {
  return c.size_points ?? DEFAULT_POINTS;
}

async function fetchActiveCards(): Promise<RawCard[]> {
  const service = createServiceClient();
  const { data, error } = await service
    .schema('ops')
    .from('kanban_cards')
    .select(
      'id, board_id, title, column_key, tags, size_points, priority, assignee, blocked_by, done_at, created_at, updated_at',
    )
    .is('archived_at', null);
  if (error) throw new Error(error.message);
  return (data ?? []) as RawCard[];
}

export type LaunchRollup = {
  totalPoints: number;
  donePoints: number;
  percentDone: number;
  unsizedCards: number;
  blockerCardCount: number;
};

export async function getLaunchRollup(): Promise<LaunchRollup> {
  const cards = await fetchActiveCards();
  const blockers = cards.filter(isLaunchBlocker);
  let totalPoints = 0;
  let donePoints = 0;
  let unsizedCards = 0;
  for (const c of blockers) {
    const pts = pointsOf(c);
    totalPoints += pts;
    if (isDone(c)) donePoints += pts;
    if (c.size_points == null) unsizedCards += 1;
  }
  const percentDone = totalPoints > 0 ? Math.round((donePoints / totalPoints) * 100) : 0;
  return {
    totalPoints,
    donePoints,
    percentDone,
    unsizedCards,
    blockerCardCount: blockers.length,
  };
}

export type Velocity = {
  windowDays: number;
  completedPoints: number;
  weeklyRate: number;
};

export async function getVelocity(days = 28): Promise<Velocity> {
  const cards = await fetchActiveCards();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let completedPoints = 0;
  for (const c of cards) {
    if (!c.done_at) continue;
    const t = new Date(c.done_at).getTime();
    if (t >= cutoff) completedPoints += pointsOf(c);
  }
  const weeklyRate = completedPoints / (days / 7);
  return { windowDays: days, completedPoints, weeklyRate };
}

export type Eta = { weeks: number; date: string } | null;

export function getEta(remainingPoints: number, weeklyRate: number): Eta {
  if (weeklyRate <= 0 || remainingPoints <= 0) return null;
  const weeks = remainingPoints / weeklyRate;
  const ms = weeks * 7 * 24 * 60 * 60 * 1000;
  const date = new Date(Date.now() + ms).toISOString().slice(0, 10);
  return { weeks: Math.round(weeks * 10) / 10, date };
}

export type CriticalPathCard = {
  id: string;
  title: string;
  assignee: string | null;
  size_points: number | null;
  column_key: string;
  priority: number | null;
};

export async function getCriticalPath(limit = 5): Promise<CriticalPathCard[]> {
  const cards = await fetchActiveCards();
  const blockers = cards.filter(isLaunchBlocker);
  const byId = new Map(blockers.map((c) => [c.id, c]));
  // Topological sort (Kahn's). Edge: blocker -> dependent.
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const c of blockers) {
    inDeg.set(c.id, 0);
    adj.set(c.id, []);
  }
  for (const c of blockers) {
    for (const dep of c.blocked_by ?? []) {
      if (!byId.has(dep)) continue;
      adj.get(dep)?.push(c.id);
      inDeg.set(c.id, (inDeg.get(c.id) ?? 0) + 1);
    }
  }
  const tieBreak = (a: RawCard, b: RawCard) => {
    const pa = a.priority ?? 99;
    const pb = b.priority ?? 99;
    if (pa !== pb) return pa - pb;
    return a.created_at.localeCompare(b.created_at);
  };
  const ready: RawCard[] = [];
  for (const [id, n] of inDeg) {
    if (n !== 0) continue;
    const card = byId.get(id);
    if (card) ready.push(card);
  }
  ready.sort(tieBreak);
  const sorted: RawCard[] = [];
  while (ready.length) {
    const next = ready.shift();
    if (!next) break;
    sorted.push(next);
    for (const d of adj.get(next.id) ?? []) {
      const v = (inDeg.get(d) ?? 0) - 1;
      inDeg.set(d, v);
      if (v === 0) {
        const card = byId.get(d);
        if (card) ready.push(card);
        ready.sort(tieBreak);
      }
    }
  }
  return sorted
    .filter((c) => !isDone(c))
    .slice(0, limit)
    .map((c) => ({
      id: c.id,
      title: c.title,
      assignee: c.assignee,
      size_points: c.size_points,
      column_key: c.column_key,
      priority: c.priority,
    }));
}

export type NextCard = {
  id: string;
  title: string;
  column_key: string;
  priority: number | null;
  size_points: number | null;
} | null;

export async function getNextForAssignee(assignee: string): Promise<NextCard> {
  const cards = await fetchActiveCards();
  const byId = new Map(cards.map((c) => [c.id, c]));
  const mine = cards.filter(
    (c) =>
      c.assignee === assignee &&
      (c.column_key === 'todo' || c.column_key === 'backlog') &&
      !isDone(c),
  );
  const unblocked = mine.filter((c) => {
    const deps = c.blocked_by ?? [];
    return deps.every((d) => {
      const dep = byId.get(d);
      return !dep || isDone(dep);
    });
  });
  unblocked.sort((a, b) => {
    const pa = a.priority ?? 99;
    const pb = b.priority ?? 99;
    if (pa !== pb) return pa - pb;
    // Prefer todo over backlog.
    if (a.column_key !== b.column_key) return a.column_key === 'todo' ? -1 : 1;
    return a.created_at.localeCompare(b.created_at);
  });
  const top = unblocked[0];
  if (!top) return null;
  return {
    id: top.id,
    title: top.title,
    column_key: top.column_key,
    priority: top.priority,
    size_points: top.size_points,
  };
}

export type StuckCard = {
  id: string;
  title: string;
  assignee: string | null;
  daysStuck: number;
  reason: 'doing_14d' | 'blocking_critical_unassigned';
};

export async function getStuck(limit = 10): Promise<StuckCard[]> {
  const cards = await fetchActiveCards();
  const now = Date.now();
  const out: StuckCard[] = [];

  for (const c of cards) {
    if (c.column_key !== 'doing' || c.done_at) continue;
    const ageMs = now - new Date(c.updated_at).getTime();
    const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    if (days >= 14) {
      out.push({
        id: c.id,
        title: c.title,
        assignee: c.assignee,
        daysStuck: days,
        reason: 'doing_14d',
      });
    }
  }

  // Cards on critical path that are unassigned and blocking.
  const critical = await getCriticalPath(limit);
  const byId = new Map(cards.map((c) => [c.id, c]));
  for (const cp of critical) {
    const full = byId.get(cp.id);
    if (!full) continue;
    if (!full.assignee) {
      // Only add if not already in out.
      if (!out.some((o) => o.id === full.id)) {
        const ageDays = Math.floor(
          (now - new Date(full.updated_at).getTime()) / (24 * 60 * 60 * 1000),
        );
        out.push({
          id: full.id,
          title: full.title,
          assignee: null,
          daysStuck: ageDays,
          reason: 'blocking_critical_unassigned',
        });
      }
    }
  }

  out.sort((a, b) => b.daysStuck - a.daysStuck);
  return out.slice(0, limit);
}

export type EpicHealth = {
  slug: string;
  cardCount: number;
  donePoints: number;
  totalPoints: number;
  percent: number;
  weeklyVelocity: number;
  blockerCount: number;
  stuckCount: number;
  healthScore: number;
};

export async function getEpicHealth(): Promise<EpicHealth[]> {
  const cards = await fetchActiveCards();
  const now = Date.now();
  const fourWeeksAgo = now - 28 * 24 * 60 * 60 * 1000;
  const byEpic = new Map<string, RawCard[]>();
  for (const c of cards) {
    for (const t of c.tags ?? []) {
      if (!t.startsWith('epic:')) continue;
      const slug = t.slice('epic:'.length);
      let list = byEpic.get(slug);
      if (!list) {
        list = [];
        byEpic.set(slug, list);
      }
      list.push(c);
    }
  }

  const out: EpicHealth[] = [];
  for (const [slug, list] of byEpic) {
    let totalPoints = 0;
    let donePoints = 0;
    let recentlyDone = 0;
    let blockerCount = 0;
    let stuckCount = 0;
    for (const c of list) {
      const pts = pointsOf(c);
      totalPoints += pts;
      if (isDone(c)) {
        donePoints += pts;
        if (c.done_at && new Date(c.done_at).getTime() >= fourWeeksAgo) {
          recentlyDone += pts;
        }
      }
      if (c.column_key === 'blocked') blockerCount += 1;
      if (
        c.column_key === 'doing' &&
        !c.done_at &&
        now - new Date(c.updated_at).getTime() >= 14 * 24 * 60 * 60 * 1000
      ) {
        stuckCount += 1;
      }
    }
    const percent = totalPoints > 0 ? Math.round((donePoints / totalPoints) * 100) : 0;
    const weeklyVelocity = recentlyDone / 4;
    const remaining = Math.max(0, totalPoints - donePoints);
    // Required velocity to finish in 8 weeks.
    const requiredRate = remaining > 0 ? remaining / 8 : 0;
    const velocityScore =
      requiredRate <= 0 ? 100 : Math.min(100, (weeklyVelocity / requiredRate) * 100);
    const blockerPenalty = Math.min(100, blockerCount * 25);
    const stuckPenalty = Math.min(100, stuckCount * 25);
    const healthScore = Math.round(
      percent * 0.4 +
        velocityScore * 0.3 +
        (100 - blockerPenalty) * 0.2 +
        (100 - stuckPenalty) * 0.1,
    );
    out.push({
      slug,
      cardCount: list.length,
      donePoints,
      totalPoints,
      percent,
      weeklyVelocity: Math.round(weeklyVelocity * 10) / 10,
      blockerCount,
      stuckCount,
      healthScore: Math.max(0, Math.min(100, healthScore)),
    });
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

export type ShippedCard = {
  id: string;
  title: string;
  size_points: number | null;
  done_at: string;
};

export async function getRecentlyShipped(limit = 5): Promise<ShippedCard[]> {
  const service = createServiceClient();
  const { data, error } = await service
    .schema('ops')
    .from('kanban_cards')
    .select('id, title, size_points, done_at')
    .is('archived_at', null)
    .not('done_at', 'is', null)
    .order('done_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map((c) => ({
    id: c.id as string,
    title: c.title as string,
    size_points: (c.size_points as number | null) ?? null,
    done_at: c.done_at as string,
  }));
}

export const FIBONACCI_SIZES = [1, 2, 3, 5, 8, 13, 21] as const;
export type SizePoints = (typeof FIBONACCI_SIZES)[number];

export async function setCardSize(id: string, points: SizePoints | null) {
  const service = createServiceClient();
  const { error } = await service
    .schema('ops')
    .from('kanban_cards')
    .update({ size_points: points, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
  return { ok: true as const };
}
