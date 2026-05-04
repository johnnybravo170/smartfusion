/**
 * Project Pulse — Henry-drafting service.
 *
 * Translates internal task state into a homeowner-friendly progress summary.
 * The owner edits the draft and approves before anything is sent — see
 * `src/server/actions/pulse.ts`.
 *
 * What clients NEVER see (filtered HERE, at the data layer, not at the
 * prompt):
 *   - Assignees, crew names
 *   - Internal notes, blocker_reason text
 *   - Dollar amounts
 *   - Unverified `done` tasks (only verified count as completed)
 *   - Draft phases (we don't surface phase names directly anyway)
 */

import { gateway } from '@/lib/ai-gateway';
import { createAdminClient } from '@/lib/supabase/admin';

export type PulsePayload = {
  completed: { title: string }[];
  in_progress: { title: string }[];
  waiting_on_you: { title: string; action_url?: string; deadline?: string }[];
  up_next: { title: string; estimated_date?: string }[];
  /** ISO date string of the job's target completion, if known. */
  eta?: string;
};

export type PulseDraft = {
  title: string;
  body_md: string;
  payload: PulsePayload;
};

/**
 * Build a fresh Pulse draft for a job. Pure read — does not write to
 * `pulse_updates`. The action layer persists.
 */
export async function draftPulseUpdate(jobId: string): Promise<PulseDraft> {
  const admin = createAdminClient();

  // 1. Job + customer context. We use the admin client so this can be
  //    invoked from the AI tool layer (which doesn't always run with a
  //    user session). Tenant scoping is already enforced upstream by the
  //    caller (server action checks getCurrentTenant; AI tool wraps it).
  const { data: jobRow, error: jobErr } = await admin
    .from('jobs')
    .select('id, scheduled_at, customers:customer_id (name)')
    .eq('id', jobId)
    .is('deleted_at', null)
    .maybeSingle();

  if (jobErr || !jobRow) throw new Error(`Job not found: ${jobId}`);

  const customerRaw = jobRow.customers as { name?: string } | { name?: string }[] | null;
  const customerObj = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;
  const projectName = (customerObj?.name as string) ?? 'Your Project';

  // 2. Tasks. Pull only what the homeowner is allowed to influence.
  //    Assignee/blocker_reason are SELECTed but never returned to the
  //    client — they stay inside this function for filtering decisions.
  const { data: tasksRaw } = await admin
    .from('tasks')
    .select(
      'id, title, status, phase, due_date, completed_at, verified_at, client_summary, visibility',
    )
    .eq('job_id', jobId)
    .order('updated_at', { ascending: false });

  const tasks = (tasksRaw ?? []) as Array<{
    id: string;
    title: string;
    status: string;
    phase: string | null;
    due_date: string | null;
    completed_at: string | null;
    verified_at: string | null;
    client_summary: string | null;
    visibility: string;
  }>;

  // Bucket. Use `client_summary` when present, otherwise the raw title —
  // never expose blocker text or assignee names.
  const titleOf = (t: { title: string; client_summary: string | null }) =>
    (t.client_summary?.trim() || t.title).trim();

  const completed = tasks
    .filter((t) => t.status === 'verified')
    .slice(0, 8)
    .map((t) => ({ title: titleOf(t) }));

  const in_progress = tasks
    .filter((t) => t.status === 'in_progress')
    .slice(0, 6)
    .map((t) => ({ title: titleOf(t) }));

  const waiting_on_you = tasks
    .filter((t) => t.status === 'waiting_client')
    .slice(0, 6)
    .map((t) => ({
      title: titleOf(t),
      ...(t.due_date ? { deadline: t.due_date } : {}),
    }));

  // "Up next" = ready or unstarted tasks in phases other than the current
  // active one. We approximate "current phase" as the phase with the most
  // in_progress / waiting tasks; everything else with status=ready becomes
  // "up next". If we can't determine, fall back to the first 4 ready rows.
  const phaseScore = new Map<string, number>();
  for (const t of tasks) {
    if (!t.phase) continue;
    if (t.status === 'in_progress' || t.status === 'waiting_client') {
      phaseScore.set(t.phase, (phaseScore.get(t.phase) ?? 0) + 1);
    }
  }
  const currentPhase = [...phaseScore.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const up_next = tasks
    .filter((t) => t.status === 'ready' && (!currentPhase || t.phase !== currentPhase))
    .slice(0, 5)
    .map((t) => ({
      title: titleOf(t),
      ...(t.due_date ? { estimated_date: t.due_date } : {}),
    }));

  const eta = (jobRow.scheduled_at as string | null) ?? undefined;

  const payload: PulsePayload = {
    completed,
    in_progress,
    waiting_on_you,
    up_next,
    ...(eta ? { eta } : {}),
  };

  // 3. Hand the *already-filtered* payload to Claude. The prompt is a
  //    safety net, not the security boundary — the data the model sees
  //    contains no assignees or dollar amounts to leak in the first place.
  const title = `Your Project — ${projectName}`;
  const body_md = await renderBody({ title, payload });

  return { title, body_md, payload };
}

const SYSTEM_PROMPT = `You are Henry, an AI assistant that writes plain-English progress updates for homeowners on renovation projects.

Your output is read by a non-technical homeowner. You are NOT writing to a contractor.

Rules:
- Translate, don't list-dump. The homeowner wants to know: What happened? What's happening now? What's next? Is anything waiting on me? Are we on track?
- Use the exact bullet glyphs shown below. No markdown headings, no bold, no links.
- Be warm and concise. No filler. No apologies.
- Never invent items not present in the input.
- If a section has no items, omit it entirely (don't say "nothing to report").
- Keep it under 180 words.

Format:
Your Project — <project name>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ <completed item>
...
▶ In progress: <one-line summary of in-progress items>

⚠ Waiting on you: <ask>  (only if waiting_on_you is non-empty)

◦ Up next: <next phase summary>
◦ Estimated completion: <human date>  (only if eta given)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

async function renderBody(args: { title: string; payload: PulsePayload }): Promise<string> {
  // If there's literally nothing to report, don't bother calling the model.
  const p = args.payload;
  const empty =
    p.completed.length === 0 &&
    p.in_progress.length === 0 &&
    p.waiting_on_you.length === 0 &&
    p.up_next.length === 0;
  if (empty) {
    return `${args.title}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nNo new updates yet — we'll send one as soon as work begins.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  }

  const userMsg = [
    `Project name (for the header): ${args.title.replace(/^Your Project — /, '')}`,
    '',
    'Structured payload (already filtered — safe to surface as-is):',
    JSON.stringify(p, null, 2),
  ].join('\n');

  const res = await gateway().runChat({
    kind: 'chat',
    task: 'pulse_progress_draft',
    model_override: process.env.PULSE_MODEL,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMsg }],
    max_tokens: 600,
  });
  return res.text.trim();
}
