'use server';

/**
 * Server actions for the customer idea board.
 *
 * Phase 1 of CUSTOMER_IDEA_BOARD_PLAN.md. Three customer-side affordances
 * (image / link / note) backed by a single discriminated table. Operator-
 * side reads via the authenticated server client; the Selections tab pill
 * surfaces an unread count badge but no external notification fires.
 *
 * Customer-side writes go through the admin client + portal_slug auth
 * pattern (mirror of postCustomerPortalMessageAction in
 * project-messages.ts).
 */

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { fetchUrlPreview } from '@/lib/idea-board/url-preview';
import {
  deleteIdeaBoardImage,
  ideaBoardStoragePath,
  signIdeaBoardImageUrls,
  uploadIdeaBoardImage,
} from '@/lib/storage/idea-board';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export type SimpleResult = { ok: true } | { ok: false; error: string };

export type IdeaBoardItem = {
  id: string;
  project_id: string;
  customer_id: string | null;
  kind: 'image' | 'link' | 'note';
  image_storage_path: string | null;
  source_url: string | null;
  thumbnail_url: string | null;
  title: string | null;
  notes: string | null;
  room: string | null;
  read_by_operator_at: string | null;
  promoted_to_selection_id: string | null;
  promoted_at: string | null;
  created_at: string;
  /** Resolved server-side; signed URL for image kind. */
  image_url?: string | null;
};

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB before resize, post-resize we'd be much smaller
const MAX_TITLE_LENGTH = 280;
const MAX_NOTES_LENGTH = 4000;
const MAX_ROOM_LENGTH = 80;
const MAX_URL_LENGTH = 2048;

// Per-portal-slug rate limit for URL preview fetches: prevents the portal
// from being used as a free URL-validation oracle. In-process map; lost on
// restart — adequate for the abuse profile we're worried about.
const previewRateLimit = new Map<string, number[]>();
const PREVIEW_RATE_LIMIT_MAX = 10;
const PREVIEW_RATE_LIMIT_WINDOW_MS = 60_000;

function trimText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;
  return t.slice(0, max);
}

async function resolveProjectFromSlug(
  admin: ReturnType<typeof createAdminClient>,
  portalSlug: string,
): Promise<{ projectId: string; tenantId: string; customerId: string | null } | null> {
  const { data } = await admin
    .from('projects')
    .select('id, tenant_id, customer_id, portal_enabled')
    .eq('portal_slug', portalSlug)
    .eq('portal_enabled', true)
    .is('deleted_at', null)
    .single();
  if (!data) return null;
  return {
    projectId: (data as Record<string, unknown>).id as string,
    tenantId: (data as Record<string, unknown>).tenant_id as string,
    customerId: ((data as Record<string, unknown>).customer_id as string | null) ?? null,
  };
}

async function attachImageUrls(
  admin: ReturnType<typeof createAdminClient>,
  rows: IdeaBoardItem[],
): Promise<IdeaBoardItem[]> {
  const paths = rows.map((r) => r.image_storage_path).filter((p): p is string => Boolean(p));
  if (paths.length === 0) return rows;
  const map = await signIdeaBoardImageUrls(admin, paths);
  return rows.map((r) => ({
    ...r,
    image_url: r.image_storage_path ? (map.get(r.image_storage_path) ?? null) : null,
  }));
}

// ============================================================================
// Customer side — portal_slug auth via admin client
// ============================================================================

export async function getCustomerIdeaBoardItemsAction(
  portalSlug: string,
): Promise<{ ok: true; items: IdeaBoardItem[] } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const project = await resolveProjectFromSlug(admin, portalSlug);
  if (!project) return { ok: false, error: 'Portal not found.' };

  const { data, error } = await admin
    .from('project_idea_board_items')
    .select(
      'id, project_id, customer_id, kind, image_storage_path, source_url, thumbnail_url, title, notes, room, read_by_operator_at, promoted_to_selection_id, promoted_at, created_at',
    )
    .eq('project_id', project.projectId)
    .order('created_at', { ascending: false });
  if (error) return { ok: false, error: error.message };

  const items = await attachImageUrls(admin, (data ?? []) as IdeaBoardItem[]);
  return { ok: true, items };
}

export async function addCustomerIdeaBoardImageAction(
  formData: FormData,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const portalSlug = formData.get('portal_slug');
  if (typeof portalSlug !== 'string') return { ok: false, error: 'Missing portal slug.' };

  const file = formData.get('file');
  if (!(file instanceof Blob)) return { ok: false, error: 'No file uploaded.' };
  if (file.size === 0) return { ok: false, error: 'File is empty.' };
  if (file.size > MAX_IMAGE_BYTES) return { ok: false, error: 'Image too large (max 10MB).' };

  const contentType = file.type || 'image/jpeg';
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    return { ok: false, error: 'Only JPEG, PNG, WebP, or GIF images are supported.' };
  }

  const room = trimText(formData.get('room'), MAX_ROOM_LENGTH);
  const notes = trimText(formData.get('notes'), MAX_NOTES_LENGTH);
  const title = trimText(formData.get('title'), MAX_TITLE_LENGTH);

  const admin = createAdminClient();
  const project = await resolveProjectFromSlug(admin, portalSlug);
  if (!project) return { ok: false, error: 'Portal not found.' };

  const itemId = randomUUID();
  const ext = contentType.split('/')[1] ?? 'jpg';
  const storagePath = ideaBoardStoragePath({
    tenantId: project.tenantId,
    projectId: project.projectId,
    itemId,
    extension: ext,
  });

  const upload = await uploadIdeaBoardImage(admin, {
    storagePath,
    file,
    contentType,
  });
  if (!upload.ok) return { ok: false, error: upload.error };

  const { error } = await admin.from('project_idea_board_items').insert({
    id: itemId,
    tenant_id: project.tenantId,
    project_id: project.projectId,
    customer_id: project.customerId,
    kind: 'image',
    image_storage_path: storagePath,
    title,
    notes,
    room,
  });
  if (error) {
    // Best-effort cleanup of the orphan storage object.
    await deleteIdeaBoardImage(admin, storagePath).catch(() => {});
    return { ok: false, error: error.message };
  }

  return { ok: true, id: itemId };
}

export async function addCustomerIdeaBoardLinkAction(input: {
  portalSlug: string;
  url: string;
  title?: string;
  thumbnailUrl?: string | null;
  notes?: string;
  room?: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const url = trimText(input.url, MAX_URL_LENGTH);
  if (!url) return { ok: false, error: 'URL is required.' };
  // Validate parseability and protocol; don't refetch (preview already fetched).
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, error: 'Only http(s) URLs are supported.' };
    }
  } catch {
    return { ok: false, error: 'Invalid URL.' };
  }

  const admin = createAdminClient();
  const project = await resolveProjectFromSlug(admin, input.portalSlug);
  if (!project) return { ok: false, error: 'Portal not found.' };

  const { data, error } = await admin
    .from('project_idea_board_items')
    .insert({
      tenant_id: project.tenantId,
      project_id: project.projectId,
      customer_id: project.customerId,
      kind: 'link',
      source_url: url,
      thumbnail_url: trimText(input.thumbnailUrl, MAX_URL_LENGTH),
      title: trimText(input.title, MAX_TITLE_LENGTH),
      notes: trimText(input.notes, MAX_NOTES_LENGTH),
      room: trimText(input.room, MAX_ROOM_LENGTH),
    })
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not save link.' };
  return { ok: true, id: (data as { id: string }).id };
}

export async function addCustomerIdeaBoardNoteAction(input: {
  portalSlug: string;
  notes: string;
  room?: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const notes = trimText(input.notes, MAX_NOTES_LENGTH);
  if (!notes) return { ok: false, error: 'Note is empty.' };

  const admin = createAdminClient();
  const project = await resolveProjectFromSlug(admin, input.portalSlug);
  if (!project) return { ok: false, error: 'Portal not found.' };

  const { data, error } = await admin
    .from('project_idea_board_items')
    .insert({
      tenant_id: project.tenantId,
      project_id: project.projectId,
      customer_id: project.customerId,
      kind: 'note',
      notes,
      room: trimText(input.room, MAX_ROOM_LENGTH),
    })
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not save note.' };
  return { ok: true, id: (data as { id: string }).id };
}

export async function deleteCustomerIdeaBoardItemAction(input: {
  portalSlug: string;
  itemId: string;
}): Promise<SimpleResult> {
  const admin = createAdminClient();
  const project = await resolveProjectFromSlug(admin, input.portalSlug);
  if (!project) return { ok: false, error: 'Portal not found.' };

  // Verify the item belongs to the resolved project before deleting,
  // so a slug from one project can't be used to delete another's items.
  const { data: row } = await admin
    .from('project_idea_board_items')
    .select('id, project_id, image_storage_path')
    .eq('id', input.itemId)
    .single();
  if (!row || (row as Record<string, unknown>).project_id !== project.projectId) {
    return { ok: false, error: 'Item not found.' };
  }

  const storagePath = (row as Record<string, unknown>).image_storage_path as string | null;
  if (storagePath) {
    await deleteIdeaBoardImage(admin, storagePath).catch(() => {});
  }
  const { error } = await admin.from('project_idea_board_items').delete().eq('id', input.itemId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function fetchIdeaBoardUrlPreviewAction(input: {
  portalSlug: string;
  url: string;
}): Promise<
  | { ok: true; preview: { thumbnail_url: string | null; title: string | null } }
  | { ok: false; error: string }
> {
  // Verify portal first — even though the preview helper itself doesn't
  // touch the project, we don't want to expose an unauthenticated URL-
  // validation oracle to the world.
  const admin = createAdminClient();
  const project = await resolveProjectFromSlug(admin, input.portalSlug);
  if (!project) return { ok: false, error: 'Portal not found.' };

  // Per-slug rate limit. Trims the in-process bucket of timestamps older
  // than the window before checking + appending.
  const now = Date.now();
  const bucket = previewRateLimit.get(input.portalSlug) ?? [];
  const fresh = bucket.filter((t) => now - t < PREVIEW_RATE_LIMIT_WINDOW_MS);
  if (fresh.length >= PREVIEW_RATE_LIMIT_MAX) {
    return { ok: false, error: 'Too many preview requests, please slow down.' };
  }
  fresh.push(now);
  previewRateLimit.set(input.portalSlug, fresh);

  const result = await fetchUrlPreview(input.url);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, preview: result.preview };
}

// ============================================================================
// Operator side — authenticated server client, RLS-enforced
// ============================================================================

export async function getProjectIdeaBoardItemsAction(
  projectId: string,
): Promise<{ ok: true; items: IdeaBoardItem[] } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('project_idea_board_items')
    .select(
      'id, project_id, customer_id, kind, image_storage_path, source_url, thumbnail_url, title, notes, room, read_by_operator_at, promoted_to_selection_id, promoted_at, created_at',
    )
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) return { ok: false, error: error.message };

  // Sign image URLs via the admin client — operator's authed JWT also has
  // bucket access, but we keep the signing path consistent with the
  // customer-side renderer.
  const admin = createAdminClient();
  const items = await attachImageUrls(admin, (data ?? []) as IdeaBoardItem[]);
  return { ok: true, items };
}

export async function markIdeaBoardItemsReadAction(projectId: string): Promise<SimpleResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('project_idea_board_items')
    .update({ read_by_operator_at: new Date().toISOString() })
    .eq('project_id', projectId)
    .is('read_by_operator_at', null);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

/**
 * Phase 2 — stamp an idea-board item as promoted to a specific selection.
 *
 * The selection itself was already created by SelectionFormDialog's
 * onAfterCreate callback; this action is the second leg, recording the
 * link so we can render the "Promoted" pill and avoid double-promotes.
 *
 * Idempotent on re-call. The original idea-board row stays intact —
 * operators never delete customer-authored content.
 */
export async function markIdeaBoardItemPromotedAction(input: {
  itemId: string;
  selectionId: string;
}): Promise<SimpleResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { data: row, error: readErr } = await supabase
    .from('project_idea_board_items')
    .select('id, project_id')
    .eq('id', input.itemId)
    .single();
  if (readErr || !row) return { ok: false, error: readErr?.message ?? 'Idea not found.' };

  const { error } = await supabase
    .from('project_idea_board_items')
    .update({
      promoted_to_selection_id: input.selectionId,
      promoted_at: new Date().toISOString(),
    })
    .eq('id', input.itemId);
  if (error) return { ok: false, error: error.message };

  const projectId = (row as Record<string, unknown>).project_id as string;
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
