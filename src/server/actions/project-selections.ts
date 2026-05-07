'use server';

/**
 * Server actions for per-room material selections. Slice 4 of the
 * Customer Portal build, extended for customer-side authoring.
 *
 * Operator mutations run through the RLS-aware client; tenant isolation
 * is enforced by `current_tenant_id()` policies on `project_selections`.
 *
 * Customer mutations come in via the public portal (no Supabase auth
 * context) — they go through the admin client + portal_slug auth, same
 * pattern as the customer idea board and project messages. Customer
 * writes always stamp `created_by='customer'`; the customer can only
 * edit/delete rows with that flag (verified server-side).
 */

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { ideaBoardStoragePath, uploadIdeaBoardImage } from '@/lib/storage/idea-board';
import { createAdminClient } from '@/lib/supabase/admin';
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
      created_by: 'operator',
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

// ============================================================================
// Customer-side (portal_slug auth via admin client)
// ============================================================================

const CUSTOMER_ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const CUSTOMER_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const CUSTOMER_MAX_NOTES = 4000;
const CUSTOMER_MAX_NAME = 280;
const CUSTOMER_MAX_ROOM = 80;
const CUSTOMER_MAX_CODE = 80;

function trimText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;
  return t.slice(0, max);
}

async function resolveCustomerProject(
  admin: ReturnType<typeof createAdminClient>,
  portalSlug: string,
): Promise<{ projectId: string; tenantId: string } | null> {
  const { data } = await admin
    .from('projects')
    .select('id, tenant_id, portal_enabled')
    .eq('portal_slug', portalSlug)
    .eq('portal_enabled', true)
    .is('deleted_at', null)
    .single();
  if (!data) return null;
  return {
    projectId: (data as Record<string, unknown>).id as string,
    tenantId: (data as Record<string, unknown>).tenant_id as string,
  };
}

/**
 * Customer creates a selection from the portal. Composer is intentionally
 * lighter than the operator dialog (room, name, optional color code,
 * notes, single image) — this is "what I chose" not the full install
 * spec.
 */
export async function addCustomerSelectionAction(
  formData: FormData,
): Promise<SelectionActionResult> {
  const portalSlug = formData.get('portal_slug');
  if (typeof portalSlug !== 'string') return { ok: false, error: 'Missing portal slug.' };

  const room = trimText(formData.get('room'), CUSTOMER_MAX_ROOM);
  if (!room) return { ok: false, error: 'Room is required.' };

  const categoryRaw = formData.get('category');
  const category =
    typeof categoryRaw === 'string' && isSelectionCategory(categoryRaw) ? categoryRaw : 'other';

  const name = trimText(formData.get('name'), CUSTOMER_MAX_NAME);
  const code = trimText(formData.get('code'), CUSTOMER_MAX_CODE);
  const notes = trimText(formData.get('notes'), CUSTOMER_MAX_NOTES);

  const admin = createAdminClient();
  const project = await resolveCustomerProject(admin, portalSlug);
  if (!project) return { ok: false, error: 'Portal not found.' };

  // Optional inline image — same path-prefix convention as the idea
  // board. We deliberately reuse the photos bucket without writing a
  // companion photos table row (matches Idea Board pattern).
  let imageStoragePath: string | null = null;
  const file = formData.get('file');
  if (file instanceof Blob && file.size > 0) {
    if (file.size > CUSTOMER_MAX_IMAGE_BYTES) {
      return { ok: false, error: 'Image too large (max 10MB).' };
    }
    const contentType = file.type || 'image/jpeg';
    if (!CUSTOMER_ALLOWED_IMAGE_TYPES.has(contentType)) {
      return { ok: false, error: 'Only JPEG, PNG, WebP, or GIF images are supported.' };
    }
    const ext = contentType.split('/')[1] ?? 'jpg';
    const itemId = randomUUID();
    const path = ideaBoardStoragePath({
      tenantId: project.tenantId,
      projectId: project.projectId,
      itemId,
      extension: ext,
    });
    const upload = await uploadIdeaBoardImage(admin, {
      storagePath: path,
      file,
      contentType,
    });
    if (!upload.ok) return { ok: false, error: upload.error };
    imageStoragePath = path;
  }

  const { data, error } = await admin
    .from('project_selections')
    .insert({
      tenant_id: project.tenantId,
      project_id: project.projectId,
      room,
      category,
      name,
      code,
      notes,
      image_storage_path: imageStoragePath,
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not save selection.' };

  return { ok: true, id: (data as Record<string, unknown>).id as string };
}

export async function deleteCustomerSelectionAction(input: {
  portalSlug: string;
  selectionId: string;
}): Promise<SelectionActionResult> {
  const admin = createAdminClient();
  const project = await resolveCustomerProject(admin, input.portalSlug);
  if (!project) return { ok: false, error: 'Portal not found.' };

  // Verify the row belongs to this project AND was authored by the
  // customer — operators delete via their own action.
  const { data: row } = await admin
    .from('project_selections')
    .select('id, project_id, created_by')
    .eq('id', input.selectionId)
    .single();
  if (
    !row ||
    (row as Record<string, unknown>).project_id !== project.projectId ||
    (row as Record<string, unknown>).created_by !== 'customer'
  ) {
    return { ok: false, error: 'Selection not found.' };
  }

  const { error } = await admin.from('project_selections').delete().eq('id', input.selectionId);
  if (error) return { ok: false, error: error.message };
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
