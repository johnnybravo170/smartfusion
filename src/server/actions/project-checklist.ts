'use server';

/**
 * Server actions for the per-project team checklist.
 *
 * Collaborative by design: any authenticated tenant member can add /
 * check / uncheck / delete items. RLS enforces tenant isolation.
 *
 * Result shape per PATTERNS.md §5: `{ ok, error, fieldErrors? }`. No throws
 * for expected failures.
 */

import { revalidatePath } from 'next/cache';
import type { z } from 'zod';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import {
  deleteChecklistAttachment,
  uploadChecklistAttachment,
} from '@/lib/storage/project-checklist';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import {
  checklistHideHoursSchema,
  checklistItemCreateSchema,
  checklistItemIdSchema,
  checklistItemTitleUpdateSchema,
} from '@/lib/validators/project-checklist';

export type ChecklistActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export type ChecklistVoidResult = { ok: true } | { ok: false; error: string };

function flattenZod(err: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    if (!out[key]) out[key] = [];
    out[key].push(issue.message);
  }
  return out;
}

function revalidateForProject(projectId: string) {
  revalidatePath('/w');
  revalidatePath(`/w/projects/${projectId}`);
  revalidatePath('/dashboard');
  revalidatePath('/checklists');
  revalidatePath(`/projects/${projectId}`);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function addChecklistItemAction(
  input: Record<string, unknown>,
): Promise<ChecklistActionResult> {
  const tenant = await getCurrentTenant();
  const user = await getCurrentUser();
  if (!tenant || !user) return { ok: false, error: 'Not signed in.' };

  const parsed = checklistItemCreateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Check the highlighted fields.',
      fieldErrors: flattenZod(parsed.error),
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('project_checklist_items')
    .insert({
      tenant_id: tenant.id,
      project_id: parsed.data.projectId,
      title: parsed.data.title,
      category: parsed.data.category,
      created_by: user.id,
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Could not save.' };
  }

  revalidateForProject(parsed.data.projectId);
  return { ok: true, id: data.id };
}

export async function toggleChecklistItemAction(
  input: Record<string, unknown>,
): Promise<ChecklistVoidResult> {
  const tenant = await getCurrentTenant();
  const user = await getCurrentUser();
  if (!tenant || !user) return { ok: false, error: 'Not signed in.' };

  const parsed = checklistItemIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid item.' };

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from('project_checklist_items')
    .select('id, project_id, completed_at')
    .eq('id', parsed.data.itemId)
    .maybeSingle();

  if (!existing) return { ok: false, error: 'Item not found.' };

  const nowIso = new Date().toISOString();
  const nextCompletedAt = existing.completed_at ? null : nowIso;
  const nextCompletedBy = existing.completed_at ? null : user.id;

  const { error } = await supabase
    .from('project_checklist_items')
    .update({
      completed_at: nextCompletedAt,
      completed_by: nextCompletedBy,
      updated_at: nowIso,
    })
    .eq('id', parsed.data.itemId);

  if (error) return { ok: false, error: error.message };

  revalidateForProject(existing.project_id as string);
  return { ok: true };
}

export async function updateChecklistItemTitleAction(
  input: Record<string, unknown>,
): Promise<ChecklistVoidResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = checklistItemTitleUpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Title is required.' };

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from('project_checklist_items')
    .select('project_id')
    .eq('id', parsed.data.itemId)
    .maybeSingle();
  if (!existing) return { ok: false, error: 'Item not found.' };

  const { error } = await supabase
    .from('project_checklist_items')
    .update({ title: parsed.data.title, updated_at: new Date().toISOString() })
    .eq('id', parsed.data.itemId);

  if (error) return { ok: false, error: error.message };

  revalidateForProject(existing.project_id as string);
  return { ok: true };
}

export async function deleteChecklistItemAction(
  input: Record<string, unknown>,
): Promise<ChecklistVoidResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = checklistItemIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid item.' };

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from('project_checklist_items')
    .select('project_id, photo_storage_path')
    .eq('id', parsed.data.itemId)
    .maybeSingle();
  if (!existing) return { ok: false, error: 'Item not found.' };

  // Best-effort cleanup of any attached photo before the row goes away.
  if (existing.photo_storage_path) {
    await deleteChecklistAttachment(existing.photo_storage_path as string);
  }

  const { error } = await supabase
    .from('project_checklist_items')
    .delete()
    .eq('id', parsed.data.itemId);

  if (error) return { ok: false, error: error.message };

  revalidateForProject(existing.project_id as string);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Photo attach / remove
// ---------------------------------------------------------------------------

const MAX_PHOTO_BYTES = 12 * 1024 * 1024; // 12 MB cap, matches photos action

export async function attachChecklistPhotoAction(formData: FormData): Promise<ChecklistVoidResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const itemId = String(formData.get('itemId') ?? '');
  const file = formData.get('file');

  if (!itemId) return { ok: false, error: 'Missing item.' };
  if (!(file instanceof File)) return { ok: false, error: 'No photo provided.' };
  if (file.size === 0) return { ok: false, error: 'Photo is empty.' };
  if (file.size > MAX_PHOTO_BYTES) {
    return { ok: false, error: 'Photo is too large (max 12 MB).' };
  }

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from('project_checklist_items')
    .select('id, project_id, photo_storage_path')
    .eq('id', itemId)
    .maybeSingle();
  if (!existing) return { ok: false, error: 'Item not found.' };

  const ext = (file.name.split('.').pop() ?? 'jpg').toLowerCase().slice(0, 5);

  const upload = await uploadChecklistAttachment({
    tenantId: tenant.id,
    projectId: existing.project_id as string,
    itemId,
    file,
    contentType: file.type || 'image/jpeg',
    extension: ext,
  });

  if ('error' in upload) return { ok: false, error: upload.error };

  // If there was an old photo at a different path (different extension),
  // clean it up so we don't orphan storage objects.
  if (existing.photo_storage_path && existing.photo_storage_path !== upload.path) {
    await deleteChecklistAttachment(existing.photo_storage_path as string);
  }

  const { error } = await supabase
    .from('project_checklist_items')
    .update({
      photo_storage_path: upload.path,
      photo_mime: file.type || 'image/jpeg',
      updated_at: new Date().toISOString(),
    })
    .eq('id', itemId);

  if (error) return { ok: false, error: error.message };

  revalidateForProject(existing.project_id as string);
  return { ok: true };
}

export async function removeChecklistPhotoAction(
  input: Record<string, unknown>,
): Promise<ChecklistVoidResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = checklistItemIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid item.' };

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from('project_checklist_items')
    .select('project_id, photo_storage_path')
    .eq('id', parsed.data.itemId)
    .maybeSingle();
  if (!existing) return { ok: false, error: 'Item not found.' };

  if (existing.photo_storage_path) {
    await deleteChecklistAttachment(existing.photo_storage_path as string);
  }

  const { error } = await supabase
    .from('project_checklist_items')
    .update({
      photo_storage_path: null,
      photo_mime: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', parsed.data.itemId);

  if (error) return { ok: false, error: error.message };

  revalidateForProject(existing.project_id as string);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Tenant-wide settings
// ---------------------------------------------------------------------------

export async function setChecklistHideHoursAction(
  input: Record<string, unknown>,
): Promise<ChecklistVoidResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = checklistHideHoursSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: 'Pick 24h, 48h, 7 days, or never.' };
  }

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from('tenant_prefs')
    .select('data')
    .eq('tenant_id', tenant.id)
    .eq('namespace', 'checklist')
    .maybeSingle();

  const merged = {
    ...((existing?.data as Record<string, unknown> | null) ?? {}),
    hide_completed_after_hours: parsed.data.hours,
  };

  const { error } = await admin.from('tenant_prefs').upsert(
    {
      tenant_id: tenant.id,
      namespace: 'checklist',
      data: merged,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'tenant_id,namespace' },
  );

  if (error) return { ok: false, error: error.message };

  revalidatePath('/w');
  revalidatePath('/dashboard');
  revalidatePath('/checklists');
  revalidatePath('/settings');
  return { ok: true };
}
