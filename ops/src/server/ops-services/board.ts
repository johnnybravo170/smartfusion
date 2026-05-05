/**
 * Board CRUD service. Pure functions over service-role Supabase. Same
 * shape as ideas.ts / launch.ts / etc.
 *
 * The discussion engine (board-discussion.ts) builds on top of these
 * primitives — it doesn't reach into Supabase directly except for batch
 * operations that need a single round-trip.
 */

import type {
  ActionItem,
  Advisor,
  AdvisorWithKnowledge,
  BoardDecision,
  BoardMessage,
  BoardPosition,
  BoardSession,
  CreateSessionInput,
  Crux,
} from '@/lib/board/types';
import { createServiceClient } from '@/lib/supabase';

type S = ReturnType<typeof createServiceClient>;

function svc(): S {
  return createServiceClient();
}

// ── Advisors ────────────────────────────────────────────────────────────

export async function listAdvisors(opts: { include_retired?: boolean } = {}): Promise<Advisor[]> {
  const q = svc()
    .schema('ops')
    .from('advisors')
    .select('*')
    .order('sort_order', { ascending: true });
  const { data, error } = opts.include_retired ? await q : await q.eq('status', 'active');
  if (error) throw new Error(`listAdvisors: ${error.message}`);
  return (data ?? []) as Advisor[];
}

export async function getAdvisor(id: string): Promise<Advisor | null> {
  const { data, error } = await svc()
    .schema('ops')
    .from('advisors')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`getAdvisor: ${error.message}`);
  return (data ?? null) as Advisor | null;
}

export async function getAdvisorBySlug(slug: string): Promise<Advisor | null> {
  const { data, error } = await svc()
    .schema('ops')
    .from('advisors')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw new Error(`getAdvisorBySlug: ${error.message}`);
  return (data ?? null) as Advisor | null;
}

/** Hydrate advisors with their knowledge_doc body in a single round-trip. */
export async function listAdvisorsWithKnowledge(ids: string[]): Promise<AdvisorWithKnowledge[]> {
  if (ids.length === 0) return [];
  const { data, error } = await svc()
    .schema('ops')
    .from('advisors')
    .select('*, knowledge_docs:knowledge_id(body)')
    .in('id', ids);
  if (error) throw new Error(`listAdvisorsWithKnowledge: ${error.message}`);
  type Row = Advisor & { knowledge_docs?: { body?: string } | null };
  return ((data ?? []) as Row[]).map((r) => ({
    ...r,
    knowledge_body: r.knowledge_docs?.body ?? null,
  })) as AdvisorWithKnowledge[];
}

export async function createAdvisor(
  input: Omit<Advisor, 'id' | 'created_at' | 'updated_at'>,
): Promise<Advisor> {
  const { data, error } = await svc()
    .schema('ops')
    .from('advisors')
    .insert(input)
    .select('*')
    .single();
  if (error || !data) throw new Error(`createAdvisor: ${error?.message ?? 'no data'}`);
  return data as Advisor;
}

export async function updateAdvisor(id: string, patch: Partial<Advisor>): Promise<Advisor | null> {
  const { id: _drop, created_at: _c, updated_at: _u, ...rest } = patch;
  void _drop;
  void _c;
  void _u;
  const { data, error } = await svc()
    .schema('ops')
    .from('advisors')
    .update(rest)
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`updateAdvisor: ${error.message}`);
  return (data ?? null) as Advisor | null;
}

// ── Sessions ────────────────────────────────────────────────────────────

export async function listSessions(limit = 50): Promise<BoardSession[]> {
  const { data, error } = await svc()
    .schema('ops')
    .from('board_sessions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listSessions: ${error.message}`);
  return (data ?? []) as BoardSession[];
}

export async function getSession(id: string): Promise<BoardSession | null> {
  const { data, error } = await svc()
    .schema('ops')
    .from('board_sessions')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`getSession: ${error.message}`);
  return (data ?? null) as BoardSession | null;
}

export async function createSession(
  input: CreateSessionInput,
  actor: { admin_user_id?: string | null; key_id?: string | null },
): Promise<BoardSession> {
  const row = {
    title: input.title,
    topic: input.topic,
    advisor_ids: input.advisor_ids,
    provider_override: input.provider_override ?? null,
    model_override: input.model_override ?? null,
    budget_cents: input.budget_cents ?? 500,
    created_by_admin_user_id: actor.admin_user_id ?? null,
    created_by_key_id: actor.key_id ?? null,
  };
  const { data, error } = await svc()
    .schema('ops')
    .from('board_sessions')
    .insert(row)
    .select('*')
    .single();
  if (error || !data) throw new Error(`createSession: ${error?.message ?? 'no data'}`);
  return data as BoardSession;
}

export async function updateSession(
  id: string,
  patch: Partial<BoardSession>,
): Promise<BoardSession | null> {
  const { id: _drop, created_at: _c, ...rest } = patch;
  void _drop;
  void _c;
  const { data, error } = await svc()
    .schema('ops')
    .from('board_sessions')
    .update(rest)
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`updateSession: ${error.message}`);
  return (data ?? null) as BoardSession | null;
}

export async function deleteSession(id: string): Promise<boolean> {
  const { error, count } = await svc()
    .schema('ops')
    .from('board_sessions')
    .delete({ count: 'exact' })
    .eq('id', id);
  if (error) throw new Error(`deleteSession: ${error.message}`);
  return (count ?? 0) > 0;
}

/** Atomic-ish budget bump. Increments spent_cents and call_count by deltas. */
export async function incrementSessionSpend(id: string, cost_cents: number): Promise<void> {
  // Single statement via RPC would be cleaner; for now read-modify-write is
  // safe because only one engine task runs per session at a time.
  const { data: row, error: rerr } = await svc()
    .schema('ops')
    .from('board_sessions')
    .select('spent_cents, call_count')
    .eq('id', id)
    .single();
  if (rerr || !row) throw new Error(`incrementSessionSpend: ${rerr?.message ?? 'no row'}`);
  const { error } = await svc()
    .schema('ops')
    .from('board_sessions')
    .update({
      spent_cents: row.spent_cents + cost_cents,
      call_count: row.call_count + 1,
    })
    .eq('id', id);
  if (error) throw new Error(`incrementSessionSpend update: ${error.message}`);
}

// ── Cruxes ──────────────────────────────────────────────────────────────

export async function listCruxes(session_id: string): Promise<Crux[]> {
  const { data, error } = await svc()
    .schema('ops')
    .from('board_cruxes')
    .select('*')
    .eq('session_id', session_id)
    .order('sort_order', { ascending: true });
  if (error) throw new Error(`listCruxes: ${error.message}`);
  return (data ?? []) as Crux[];
}

export async function createCrux(
  session_id: string,
  label: string,
  sort_order: number,
): Promise<Crux> {
  const { data, error } = await svc()
    .schema('ops')
    .from('board_cruxes')
    .insert({ session_id, label, sort_order })
    .select('*')
    .single();
  if (error || !data) throw new Error(`createCrux: ${error?.message ?? 'no data'}`);
  return data as Crux;
}

export async function updateCrux(
  id: string,
  patch: { status?: Crux['status']; resolution_summary?: string | null; closed_at?: string | null },
): Promise<Crux | null> {
  const { data, error } = await svc()
    .schema('ops')
    .from('board_cruxes')
    .update(patch)
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`updateCrux: ${error.message}`);
  return (data ?? null) as Crux | null;
}

// ── Messages ────────────────────────────────────────────────────────────

export async function listMessages(session_id: string): Promise<BoardMessage[]> {
  const { data, error } = await svc()
    .schema('ops')
    .from('board_messages')
    .select('*')
    .eq('session_id', session_id)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listMessages: ${error.message}`);
  return (data ?? []) as BoardMessage[];
}

export async function rateMessage(
  message_id: string,
  patch: { advisor_rating?: number | null; review_note?: string | null },
): Promise<BoardMessage | null> {
  const { data, error } = await svc()
    .schema('ops')
    .from('board_messages')
    .update(patch)
    .eq('id', message_id)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`rateMessage: ${error.message}`);
  return (data ?? null) as BoardMessage | null;
}

export async function addMessage(
  input: Omit<BoardMessage, 'id' | 'created_at'>,
): Promise<BoardMessage> {
  const { data, error } = await svc()
    .schema('ops')
    .from('board_messages')
    .insert(input)
    .select('*')
    .single();
  if (error || !data) throw new Error(`addMessage: ${error?.message ?? 'no data'}`);
  return data as BoardMessage;
}

// ── Positions ───────────────────────────────────────────────────────────

export async function listPositions(session_id: string): Promise<BoardPosition[]> {
  const { data, error } = await svc()
    .schema('ops')
    .from('board_positions')
    .select('*')
    .eq('session_id', session_id);
  if (error) throw new Error(`listPositions: ${error.message}`);
  return (data ?? []) as BoardPosition[];
}

export async function upsertPosition(
  input: Omit<BoardPosition, 'id' | 'emitted_at'>,
): Promise<BoardPosition> {
  const { data, error } = await svc()
    .schema('ops')
    .from('board_positions')
    .upsert(input, { onConflict: 'session_id,advisor_id,crux_id' })
    .select('*')
    .single();
  if (error || !data) throw new Error(`upsertPosition: ${error?.message ?? 'no data'}`);
  return data as BoardPosition;
}

// ── Decisions ───────────────────────────────────────────────────────────

export async function getDecision(session_id: string): Promise<BoardDecision | null> {
  const { data, error } = await svc()
    .schema('ops')
    .from('board_decisions')
    .select('*')
    .eq('session_id', session_id)
    .maybeSingle();
  if (error) throw new Error(`getDecision: ${error.message}`);
  return (data ?? null) as BoardDecision | null;
}

export async function createDecision(
  input: Omit<
    BoardDecision,
    | 'id'
    | 'created_at'
    | 'status'
    | 'edited_decision_text'
    | 'edited_action_items'
    | 'rejected_reason'
    | 'outcome'
    | 'outcome_marked_at'
    | 'outcome_notes'
    | 'accepted_at'
    | 'promoted_at'
    | 'links'
  >,
): Promise<BoardDecision> {
  const { data, error } = await svc()
    .schema('ops')
    .from('board_decisions')
    .insert(input)
    .select('*')
    .single();
  if (error || !data) throw new Error(`createDecision: ${error?.message ?? 'no data'}`);
  return data as BoardDecision;
}

export async function updateDecision(
  id: string,
  patch: Partial<
    Pick<
      BoardDecision,
      | 'status'
      | 'edited_decision_text'
      | 'edited_action_items'
      | 'rejected_reason'
      | 'outcome'
      | 'outcome_marked_at'
      | 'outcome_notes'
      | 'accepted_at'
      | 'promoted_at'
      | 'links'
    >
  >,
): Promise<BoardDecision | null> {
  const { data, error } = await svc()
    .schema('ops')
    .from('board_decisions')
    .update(patch)
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`updateDecision: ${error.message}`);
  return (data ?? null) as BoardDecision | null;
}

// ── Stats ───────────────────────────────────────────────────────────────

export type AdvisorStatRow = {
  advisor_id: string;
  slug: string;
  name: string;
  role_kind: 'expert' | 'challenger' | 'chair';
  status: 'active' | 'retired';
  sessions: number;
  positions_taken: number;
  concessions: number;
  credited: number;
  overruled: number;
  proven_right_credit: number;
  proven_wrong_credit: number;
  overruled_but_right: number;
  avg_human_rating: number | null;
};

export async function listAdvisorStats(): Promise<AdvisorStatRow[]> {
  const { data, error } = await svc().schema('ops').from('advisor_stats').select('*');
  if (error) throw new Error(`listAdvisorStats: ${error.message}`);
  return (data ?? []) as AdvisorStatRow[];
}

// ── Action items helper (used by review flow) ──────────────────────────

export function effectiveActionItems(d: BoardDecision): ActionItem[] {
  return d.edited_action_items ?? d.action_items;
}
