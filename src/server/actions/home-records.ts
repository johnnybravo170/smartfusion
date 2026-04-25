'use server';

/**
 * Server actions for Home Record snapshot generation. Slice 6a of the
 * Customer Portal & Home Record build.
 *
 * generateHomeRecordAction reads every relevant table for a project,
 * builds a frozen JSONB snapshot, and upserts a `home_records` row
 * keyed by project_id (so regeneration is idempotent — same slug,
 * fresher data).
 *
 * Slice 6b will extend this to render a PDF, 6c a ZIP, 6d an email.
 */

import { randomBytes } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import type { HomeRecordSnapshotV1 } from '@/lib/db/queries/home-records';
import {
  type EmbeddableDoc,
  type EmbeddablePhoto,
  generateHomeRecordPdf,
} from '@/lib/pdf/home-record-pdf';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import type { PortalPhotoTag } from '@/lib/validators/portal-photo';
import type { DocumentType } from '@/lib/validators/project-document';
import type { SelectionCategory } from '@/lib/validators/project-selection';

export type HomeRecordActionResult = { ok: true; slug: string } | { ok: false; error: string };

function generateSlug(): string {
  return randomBytes(12).toString('base64url');
}

export async function generateHomeRecordAction(projectId: string): Promise<HomeRecordActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();

  // Pull the project + tenant + customer header.
  const { data: project } = await supabase
    .from('projects')
    .select(
      `id, name, description, start_date, target_end_date,
       customers:customer_id (name, address_line1, email, phone)`,
    )
    .eq('id', projectId)
    .single();
  if (!project) return { ok: false, error: 'Project not found.' };
  const p = project as Record<string, unknown>;
  const customer = (p.customers ?? null) as Record<string, unknown> | null;

  const { data: tenantRow } = await supabase
    .from('tenants')
    .select('name, logo_url')
    .eq('id', tenant.id)
    .single();
  const t = (tenantRow ?? {}) as Record<string, unknown>;

  // Phases.
  const { data: phaseRows } = await supabase
    .from('project_phases')
    .select('name, status, started_at, completed_at')
    .eq('project_id', projectId)
    .order('display_order', { ascending: true });

  // Selections.
  const { data: selectionRows } = await supabase
    .from('project_selections')
    .select('room, category, brand, name, code, finish, supplier, sku, warranty_url, notes')
    .eq('project_id', projectId)
    .order('room', { ascending: true })
    .order('display_order', { ascending: true });

  // Photos — only the ones the operator has tagged for the homeowner.
  const { data: photoRows } = await supabase
    .from('photos')
    .select('id, storage_path, caption, portal_tags, taken_at')
    .eq('project_id', projectId)
    .eq('client_visible', true)
    .is('deleted_at', null)
    .not('portal_tags', 'eq', '{}')
    .order('taken_at', { ascending: true, nullsFirst: false });

  // Documents — same client-visible filter.
  const { data: docRows } = await supabase
    .from('project_documents')
    .select('type, title, storage_path, bytes, expires_at')
    .eq('project_id', projectId)
    .eq('client_visible', true)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });

  // Decisions — only the ones the homeowner answered. Pending /
  // dismissed don't belong in a permanent record.
  const { data: decisionRows } = await supabase
    .from('project_decisions')
    .select('label, description, decided_value, decided_at, decided_by_customer')
    .eq('project_id', projectId)
    .eq('status', 'decided')
    .order('decided_at', { ascending: true });

  // Change orders — only approved ones.
  const { data: coRows } = await supabase
    .from('change_orders')
    .select(
      'title, description, cost_impact_cents, timeline_impact_days, approved_at, approved_by_name',
    )
    .eq('project_id', projectId)
    .eq('status', 'approved')
    .order('approved_at', { ascending: true });

  const snapshot: HomeRecordSnapshotV1 = {
    version: 1,
    generated_at: new Date().toISOString(),
    contractor: {
      name: (t.name as string) ?? tenant.name ?? 'Contractor',
      logo_url: (t.logo_url as string | null) ?? null,
    },
    customer: {
      name: (customer?.name as string | null) ?? null,
      address: (customer?.address_line1 as string | null) ?? null,
      email: (customer?.email as string | null) ?? null,
      phone: (customer?.phone as string | null) ?? null,
    },
    project: {
      name: (p.name as string) ?? 'Project',
      description: (p.description as string | null) ?? null,
      start_date: (p.start_date as string | null) ?? null,
      target_end_date: (p.target_end_date as string | null) ?? null,
    },
    phases: (phaseRows ?? []).map((row) => ({
      name: (row as Record<string, unknown>).name as string,
      status: (row as Record<string, unknown>).status as 'upcoming' | 'in_progress' | 'complete',
      started_at: ((row as Record<string, unknown>).started_at as string | null) ?? null,
      completed_at: ((row as Record<string, unknown>).completed_at as string | null) ?? null,
    })),
    selections: (selectionRows ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        room: r.room as string,
        category: r.category as SelectionCategory,
        brand: (r.brand as string | null) ?? null,
        name: (r.name as string | null) ?? null,
        code: (r.code as string | null) ?? null,
        finish: (r.finish as string | null) ?? null,
        supplier: (r.supplier as string | null) ?? null,
        sku: (r.sku as string | null) ?? null,
        warranty_url: (r.warranty_url as string | null) ?? null,
        notes: (r.notes as string | null) ?? null,
      };
    }),
    photos: (photoRows ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: r.id as string,
        storage_path: r.storage_path as string,
        caption: (r.caption as string | null) ?? null,
        portal_tags: ((r.portal_tags as string[] | null) ?? []) as PortalPhotoTag[],
        taken_at: (r.taken_at as string | null) ?? null,
      };
    }),
    documents: (docRows ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        type: r.type as DocumentType,
        title: r.title as string,
        storage_path: r.storage_path as string,
        bytes: (r.bytes as number | null) ?? null,
        expires_at: (r.expires_at as string | null) ?? null,
      };
    }),
    decisions: (decisionRows ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        label: r.label as string,
        description: (r.description as string | null) ?? null,
        decided_value: (r.decided_value as string | null) ?? null,
        decided_at: (r.decided_at as string | null) ?? null,
        decided_by_customer: (r.decided_by_customer as string | null) ?? null,
      };
    }),
    change_orders: (coRows ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        title: r.title as string,
        description: r.description as string,
        cost_impact_cents: (r.cost_impact_cents as number) ?? 0,
        timeline_impact_days: (r.timeline_impact_days as number) ?? 0,
        approved_at: (r.approved_at as string | null) ?? null,
        approved_by_name: (r.approved_by_name as string | null) ?? null,
      };
    }),
  };

  // Upsert keyed by project_id — preserves slug across regenerations.
  const { data: existing } = await supabase
    .from('home_records')
    .select('id, slug')
    .eq('project_id', projectId)
    .maybeSingle();

  if (existing) {
    const { error: updErr } = await supabase
      .from('home_records')
      .update({
        snapshot,
        generated_at: new Date().toISOString(),
        // Reset PDF / ZIP because the snapshot changed; subsequent slices
        // will regenerate them on demand.
        pdf_path: null,
        zip_path: null,
      })
      .eq('id', (existing as Record<string, unknown>).id as string);
    if (updErr) return { ok: false, error: updErr.message };
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, slug: (existing as Record<string, unknown>).slug as string };
  }

  const slug = generateSlug();
  const { error: insErr } = await supabase.from('home_records').insert({
    tenant_id: tenant.id,
    project_id: projectId,
    slug,
    snapshot,
  });
  if (insErr) return { ok: false, error: insErr.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, slug };
}

/**
 * Generate the branded PDF version of a home record. Reads the existing
 * snapshot from `home_records`, embeds photos as JPEG/PNG bytes,
 * builds the PDF via jsPDF, uploads to the `home-record-pdfs` bucket,
 * and writes back to `home_records.pdf_path`.
 *
 * Photos are fetched via signed URLs from the admin client and converted
 * to base64. Embedding makes the PDF permanent — even if the operator
 * later deletes a source photo, the PDF still has it.
 *
 * Document links in the PDF are clickable signed URLs. Those will
 * eventually expire (~1 week max), so the PDF should be regenerated
 * if you want to re-share with fresh links. Slice 6c (ZIP) durably
 * solves this by including actual file copies.
 */
export type HomeRecordPdfActionResult =
  | { ok: true; signedUrl: string }
  | { ok: false; error: string };

export async function generateHomeRecordPdfAction(
  projectId: string,
): Promise<HomeRecordPdfActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { data: row } = await supabase
    .from('home_records')
    .select('id, slug, snapshot')
    .eq('project_id', projectId)
    .maybeSingle();
  if (!row) {
    return { ok: false, error: 'Generate the Home Record first.' };
  }

  const r = row as Record<string, unknown>;
  const snapshot = r.snapshot as HomeRecordSnapshotV1;
  const slug = r.slug as string;
  const homeRecordId = r.id as string;

  // Resolve and fetch photo bytes. Use the admin client because the
  // photos bucket is RLS-protected and we want to bypass that for the
  // server-side embed.
  const admin = createAdminClient();

  const photoPaths = snapshot.photos.map((p) => p.storage_path);
  const embeddedPhotos: EmbeddablePhoto[] = [];
  if (photoPaths.length > 0) {
    const { data: signed } = await admin.storage.from('photos').createSignedUrls(photoPaths, 600);
    for (const entry of signed ?? []) {
      if (!entry.path || !entry.signedUrl) continue;
      try {
        const res = await fetch(entry.signedUrl);
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        const mime = res.headers.get('content-type') ?? '';
        const format: 'JPEG' | 'PNG' = mime.includes('png') ? 'PNG' : 'JPEG';
        embeddedPhotos.push({
          storage_path: entry.path,
          base64: buf.toString('base64'),
          format,
        });
      } catch {
        // Skip the photo silently rather than failing the whole PDF.
      }
    }
  }

  // Sign document URLs for clickable links in the PDF.
  const docPaths = snapshot.documents.map((d) => d.storage_path);
  const embeddedDocs: EmbeddableDoc[] = [];
  if (docPaths.length > 0) {
    const { data: signed } = await admin.storage
      .from('project-docs')
      .createSignedUrls(docPaths, 7 * 24 * 3600);
    for (const entry of signed ?? []) {
      if (entry.path && entry.signedUrl) {
        embeddedDocs.push({ storage_path: entry.path, url: entry.signedUrl });
      }
    }
  }

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = generateHomeRecordPdf(snapshot, embeddedPhotos, embeddedDocs);
  } catch (e) {
    return {
      ok: false,
      error: `PDF generation failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Upload to the home-record-pdfs bucket. Path: <tenant>/<project>/<slug>.pdf
  const storagePath = `${tenant.id}/${projectId}/${slug}.pdf`;
  const { error: upErr } = await supabase.storage
    .from('home-record-pdfs')
    .upload(storagePath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true,
    });
  if (upErr) return { ok: false, error: `Upload failed: ${upErr.message}` };

  // Write back the path so the operator UI knows it's ready.
  const { error: updErr } = await supabase
    .from('home_records')
    .update({ pdf_path: storagePath })
    .eq('id', homeRecordId);
  if (updErr) return { ok: false, error: updErr.message };

  // Mint a signed URL the caller can hand back to the browser to trigger
  // an immediate download.
  const { data: signed } = await supabase.storage
    .from('home-record-pdfs')
    .createSignedUrl(storagePath, 3600);

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, signedUrl: signed?.signedUrl ?? '' };
}
