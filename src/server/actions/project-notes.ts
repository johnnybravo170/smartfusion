'use server';

/**
 * Server actions for project notes — plain text notes, reply drafts
 * Henry generates from intake, and Henry chat Q&A turns. All land in
 * the same project_notes table and surface in the unified Notes feed.
 */

import { revalidatePath } from 'next/cache';
import { HUMAN_VOICE_RULES } from '@/lib/ai/human-voice';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export type NoteResult = { ok: true; id: string } | { ok: false; error: string };

export type NoteKind = 'text' | 'reply_draft' | 'henry_q' | 'henry_a';

export async function addProjectNoteAction(input: {
  projectId: string;
  body: string;
  kind?: NoteKind;
  metadata?: Record<string, unknown>;
}): Promise<NoteResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: 'Not authenticated.' };

  const body = input.body.trim();
  if (!body) return { ok: false, error: 'Note is empty.' };
  if (body.length > 4000) return { ok: false, error: 'Note too long (max 4000 chars).' };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('project_notes')
    .insert({
      project_id: input.projectId,
      tenant_id: tenant.id,
      user_id: user.id,
      body,
      kind: input.kind ?? 'text',
      metadata: input.metadata ?? null,
    })
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? 'Failed to add note.' };

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, id: data.id };
}

export async function deleteProjectNoteAction(input: {
  noteId: string;
  projectId: string;
}): Promise<NoteResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('project_notes')
    .delete()
    .eq('id', input.noteId)
    .eq('tenant_id', tenant.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, id: input.noteId };
}

// ─── Henry chat ────────────────────────────────────────────────────────

const HENRY_MODEL = 'gpt-4o-mini';
const HENRY_SYSTEM = `You are Henry, a Canadian general contractor's AI assistant. The contractor is asking you a question about a specific project. You have the project's name, description, customer, cost buckets, line items, and recent notes.

Answer directly and briefly. Reference real numbers from the project. If the question is about pricing or scope you don't have data for, say what's missing rather than guessing. Two short paragraphs max unless the operator clearly wants more.

${HUMAN_VOICE_RULES}`;

export type AskHenryResult = { ok: true; answer: string } | { ok: false; error: string };

export async function askHenryAboutProjectAction(input: {
  projectId: string;
  question: string;
}): Promise<AskHenryResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: 'Not authenticated.' };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: 'Server missing OPENAI_API_KEY' };

  const question = input.question.trim();
  if (!question) return { ok: false, error: 'Ask something.' };

  const supabase = await createClient();

  // 1. Save the question first so it appears immediately on refresh.
  const { error: qErr } = await supabase.from('project_notes').insert({
    project_id: input.projectId,
    tenant_id: tenant.id,
    user_id: user.id,
    body: question,
    kind: 'henry_q',
  });
  if (qErr) return { ok: false, error: `Save question: ${qErr.message}` };

  // 2. Build project context for Henry.
  const [{ data: project }, { data: bucketRows }, { data: recentNotes }] = await Promise.all([
    supabase
      .from('projects')
      .select('name, description, customers:customer_id (name)')
      .eq('id', input.projectId)
      .maybeSingle(),
    supabase
      .from('project_budget_categories')
      .select(
        'name, section, project_cost_lines (label, qty, unit, unit_price_cents, line_price_cents, notes)',
      )
      .eq('project_id', input.projectId)
      .order('display_order'),
    supabase
      .from('project_notes')
      .select('body, kind, created_at')
      .eq('project_id', input.projectId)
      .in('kind', ['text', 'henry_q', 'henry_a'])
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  if (!project) return { ok: false, error: 'Project not found.' };

  const customerName = Array.isArray(project.customers)
    ? (project.customers[0] as { name?: string } | undefined)?.name
    : (project.customers as { name?: string } | null)?.name;

  const bucketsBlock = (bucketRows ?? [])
    .map((b) => {
      const sec = b.section ? `${b.section} / ` : '';
      const lines =
        (b.project_cost_lines as Array<{
          label: string;
          qty: number;
          unit: string;
          unit_price_cents: number;
          line_price_cents: number;
          notes: string | null;
        }> | null) ?? [];
      const lineLines = lines.length
        ? lines
            .map(
              (l) =>
                `      • ${l.label} — ${l.qty} ${l.unit} @ $${(l.unit_price_cents / 100).toFixed(2)} = $${(l.line_price_cents / 100).toFixed(2)}${l.notes ? ` (${l.notes.slice(0, 80)})` : ''}`,
            )
            .join('\n')
        : '      (no lines)';
      return `  - ${sec}${b.name}\n${lineLines}`;
    })
    .join('\n');

  // Show recent notes oldest-first so the conversation reads naturally.
  const noteHistory = (recentNotes ?? [])
    .slice()
    .reverse()
    .map((n) => {
      if (n.kind === 'henry_q') return `Operator: ${n.body}`;
      if (n.kind === 'henry_a') return `Henry: ${n.body}`;
      return `Note: ${n.body}`;
    })
    .join('\n');

  const userBlock = [
    `PROJECT CONTEXT`,
    `Tenant: ${tenant.name ?? 'Contractor'}`,
    `Project: ${project.name}`,
    `Customer: ${customerName ?? '(unknown)'}`,
    `Description: ${project.description ?? '(none)'}`,
    `Buckets:\n${bucketsBlock || '  (none yet)'}`,
    '',
    noteHistory ? `RECENT ACTIVITY\n${noteHistory}` : null,
    '',
    `OPERATOR ASKED:\n${question}`,
  ]
    .filter(Boolean)
    .join('\n');

  // 3. Call OpenAI.
  const body = {
    model: HENRY_MODEL,
    messages: [
      { role: 'system', content: HENRY_SYSTEM },
      { role: 'user', content: userBlock },
    ],
  };

  let res: Response;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: `Network error: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    return { ok: false, error: `OpenAI ${res.status}: ${txt || res.statusText}` };
  }
  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const answer = payload.choices?.[0]?.message?.content?.trim();
  if (!answer) return { ok: false, error: 'Henry returned no answer.' };

  // 4. Save the answer.
  await supabase.from('project_notes').insert({
    project_id: input.projectId,
    tenant_id: tenant.id,
    user_id: user.id,
    body: answer,
    kind: 'henry_a',
    metadata: { model: HENRY_MODEL },
  });

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, answer };
}
