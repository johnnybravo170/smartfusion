'use server';

/**
 * Server actions for project documents (contracts, permits, warranties,
 * manuals, inspections, COIs). Slice 5 of the Customer Portal build.
 *
 * Uploads ride the same FormData-with-File pattern as photos. The path
 * convention is {tenant_id}/{project_id}/{random}.{ext} so the bucket
 * RLS policy (split_part on path → current_tenant_id) authorizes the
 * write.
 *
 * Soft-delete via deleted_at — keeps history for the Home Record audit
 * trail. Storage object is removed in the same call so we don't carry
 * dead bytes.
 */

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { isDocumentType } from '@/lib/validators/project-document';

export type DocumentActionResult = { ok: true; id: string } | { ok: false; error: string };

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file — PDFs and scans rarely exceed this.

export async function uploadProjectDocumentAction(
  formData: FormData,
): Promise<DocumentActionResult> {
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'No file uploaded.' };
  }
  if (file.size > MAX_BYTES) {
    return { ok: false, error: 'File is larger than 25 MB.' };
  }

  const projectId = String(formData.get('project_id') ?? '').trim();
  if (!projectId) return { ok: false, error: 'Missing project.' };

  const rawType = String(formData.get('type') ?? 'other');
  if (!isDocumentType(rawType)) return { ok: false, error: 'Invalid document type.' };

  const title = String(formData.get('title') ?? '').trim() || file.name;
  const notes = String(formData.get('notes') ?? '').trim() || null;
  const expiresAtRaw = String(formData.get('expires_at') ?? '').trim();
  const expiresAt = expiresAtRaw && /^\d{4}-\d{2}-\d{2}$/.test(expiresAtRaw) ? expiresAtRaw : null;
  const supplierIdRaw = String(formData.get('supplier_id') ?? '').trim();
  const supplierId = supplierIdRaw || null;

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();

  // Verify project belongs to the current tenant — RLS would block the
  // insert anyway, but a clean error message is friendlier.
  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .single();
  if (!project) return { ok: false, error: 'Project not found.' };

  // Upload to storage. Path: <tenant>/<project>/<random>.<ext>
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
  const safeExt = ext.replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
  const storagePath = `${tenant.id}/${projectId}/${randomUUID()}.${safeExt}`;

  const { error: upErr } = await supabase.storage.from('project-docs').upload(storagePath, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (upErr) return { ok: false, error: `Upload failed: ${upErr.message}` };

  // Insert DB row. If this fails, best-effort delete the orphaned blob.
  const { data, error: insErr } = await supabase
    .from('project_documents')
    .insert({
      tenant_id: tenant.id,
      project_id: projectId,
      type: rawType,
      title,
      storage_path: storagePath,
      mime: file.type || null,
      bytes: file.size,
      notes,
      expires_at: expiresAt,
      supplier_id: supplierId,
    })
    .select('id')
    .single();

  if (insErr || !data) {
    await supabase.storage.from('project-docs').remove([storagePath]);
    return { ok: false, error: insErr?.message ?? 'Failed to record document.' };
  }

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id: (data as Record<string, unknown>).id as string };
}

export async function deleteProjectDocumentAction(
  documentId: string,
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();

  // Read storage_path before deleting so we can clean storage too.
  const { data: doc } = await supabase
    .from('project_documents')
    .select('storage_path')
    .eq('id', documentId)
    .single();

  const { error } = await supabase
    .from('project_documents')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', documentId);
  if (error) return { ok: false, error: error.message };

  const path = (doc as Record<string, unknown> | null)?.storage_path as string | undefined;
  if (path) {
    // Best-effort — soft-delete is the source of truth.
    await supabase.storage.from('project-docs').remove([path]);
  }

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

export async function setDocumentClientVisibleAction(
  documentId: string,
  projectId: string,
  visible: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { error } = await supabase
    .from('project_documents')
    .update({ client_visible: visible })
    .eq('id', documentId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
