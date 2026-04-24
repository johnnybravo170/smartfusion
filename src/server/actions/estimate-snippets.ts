'use server';

/**
 * Server actions for the estimate-snippet library + per-project terms text.
 * All mutations go through the RLS-aware client so tenant scoping happens in
 * the DB.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export type SnippetActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

const snippetInputSchema = z.object({
  label: z.string().trim().min(1, 'Label required').max(80),
  body: z.string().trim().min(1, 'Body required').max(10000),
  isDefault: z.boolean().optional().default(false),
  displayOrder: z.number().int().min(0).max(9999).optional().default(0),
});

export type EstimateSnippetInput = z.infer<typeof snippetInputSchema>;

export async function createEstimateSnippetAction(
  input: EstimateSnippetInput,
): Promise<SnippetActionResult> {
  const parsed = snippetInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('estimate_snippets')
    .insert({
      tenant_id: tenant.id,
      label: parsed.data.label,
      body: parsed.data.body,
      is_default: parsed.data.isDefault,
      display_order: parsed.data.displayOrder,
    })
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? 'Failed to create.' };

  revalidatePath('/settings/estimate-snippets');
  return { ok: true, id: data.id };
}

export async function updateEstimateSnippetAction(
  id: string,
  input: EstimateSnippetInput,
): Promise<SnippetActionResult> {
  const parsed = snippetInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from('estimate_snippets')
    .update({
      label: parsed.data.label,
      body: parsed.data.body,
      is_default: parsed.data.isDefault,
      display_order: parsed.data.displayOrder,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/settings/estimate-snippets');
  return { ok: true, id };
}

export async function deleteEstimateSnippetAction(id: string): Promise<SnippetActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from('estimate_snippets').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/settings/estimate-snippets');
  return { ok: true, id };
}

/**
 * Save the freely-editable terms text on a project. Called by the chip
 * picker / textarea on the estimate tab.
 */
export async function patchProjectTermsTextAction(
  projectId: string,
  termsText: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!projectId) return { ok: false, error: 'Missing project id.' };
  const supabase = await createClient();
  const { error } = await supabase
    .from('projects')
    .update({ terms_text: termsText, updated_at: new Date().toISOString() })
    .eq('id', projectId)
    .is('deleted_at', null);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

/**
 * Flip the project's customer-facing document between 'estimate' (default,
 * ballpark, non-binding) and 'quote' (fixed-price, binding). Only affects
 * the heading on the customer-facing page — cost breakdown and everything
 * else is identical.
 */
export async function patchProjectDocumentTypeAction(
  projectId: string,
  documentType: 'estimate' | 'quote',
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!projectId) return { ok: false, error: 'Missing project id.' };
  if (documentType !== 'estimate' && documentType !== 'quote') {
    return { ok: false, error: 'Invalid document type.' };
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from('projects')
    .update({ document_type: documentType, updated_at: new Date().toISOString() })
    .eq('id', projectId)
    .is('deleted_at', null);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
