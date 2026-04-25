'use server';

/**
 * Server actions for per-room material selections. Slice 4 of the
 * Customer Portal build.
 *
 * All mutations run through the RLS-aware client; tenant isolation is
 * enforced by `current_tenant_id()` policies on `project_selections`.
 */

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { isSelectionCategory, type SelectionCategory } from '@/lib/validators/project-selection';

export type SelectionActionResult = { ok: true; id?: string } | { ok: false; error: string };

export type SelectionInput = {
  room: string;
  category: SelectionCategory | string;
  brand?: string | null;
  name?: string | null;
  code?: string | null;
  finish?: string | null;
  supplier?: string | null;
  sku?: string | null;
  warranty_url?: string | null;
  notes?: string | null;
  /** Budget in integer cents. Null clears any existing value. */
  allowance_cents?: number | null;
  /** Actual cost in integer cents. */
  actual_cost_cents?: number | null;
};

function normalizeCents(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.round(v));
}

function normalize(input: SelectionInput): SelectionInput | { error: string } {
  const room = input.room.trim();
  if (!room) return { error: 'Room is required.' };
  if (!isSelectionCategory(input.category)) {
    return { error: 'Invalid category.' };
  }
  return {
    room,
    category: input.category,
    brand: input.brand?.trim() || null,
    name: input.name?.trim() || null,
    code: input.code?.trim() || null,
    finish: input.finish?.trim() || null,
    supplier: input.supplier?.trim() || null,
    sku: input.sku?.trim() || null,
    warranty_url: input.warranty_url?.trim() || null,
    notes: input.notes?.trim() || null,
    allowance_cents: normalizeCents(input.allowance_cents),
    actual_cost_cents: normalizeCents(input.actual_cost_cents),
  };
}

export async function createSelectionAction(
  projectId: string,
  input: SelectionInput,
): Promise<SelectionActionResult> {
  const normalized = normalize(input);
  if ('error' in normalized) return { ok: false, error: normalized.error };

  const supabase = await createClient();
  const { data: project } = await supabase
    .from('projects')
    .select('tenant_id')
    .eq('id', projectId)
    .single();
  if (!project) return { ok: false, error: 'Project not found.' };

  const { data, error } = await supabase
    .from('project_selections')
    .insert({
      tenant_id: (project as Record<string, unknown>).tenant_id,
      project_id: projectId,
      ...normalized,
    })
    .select('id')
    .single();
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id: (data as Record<string, unknown>).id as string };
}

export async function updateSelectionAction(
  selectionId: string,
  projectId: string,
  input: SelectionInput,
): Promise<SelectionActionResult> {
  const normalized = normalize(input);
  if ('error' in normalized) return { ok: false, error: normalized.error };

  const supabase = await createClient();
  const { error } = await supabase
    .from('project_selections')
    .update(normalized)
    .eq('id', selectionId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

export async function deleteSelectionAction(
  selectionId: string,
  projectId: string,
): Promise<SelectionActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from('project_selections').delete().eq('id', selectionId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

/**
 * Update only the photo_refs jsonb on a selection. Separate from the
 * full update so the picker UI doesn't have to round-trip every other
 * field.
 */
export async function setSelectionPhotoRefsAction(
  selectionId: string,
  projectId: string,
  refs: Array<{ photo_id: string; storage_path: string; caption?: string | null }>,
): Promise<SelectionActionResult> {
  const supabase = await createClient();
  const sanitized = refs
    .filter((r) => r && typeof r.photo_id === 'string' && typeof r.storage_path === 'string')
    .map((r) => ({
      photo_id: r.photo_id,
      storage_path: r.storage_path,
      caption: r.caption ?? null,
    }));
  const { error } = await supabase
    .from('project_selections')
    .update({ photo_refs: sanitized })
    .eq('id', selectionId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
