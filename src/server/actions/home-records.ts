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
import { generateHomeRecordZip, type ZipDoc, type ZipPhoto } from '@/lib/zip/home-record-zip';

export type HomeRecordActionResult = { ok: true; slug: string } | { ok: false; error: string };

function generateSlug(): string {
  return randomBytes(12).toString('base64url');
}

/**
 * AI cluster #3 — auto-curate "best photos" for the Home Record.
 *
 * Caps each portal_tag bucket to CURATION_LIMIT_PER_TAG by
 * ai_showcase_score (descending, with taken_at as a stable tie-break).
 * Photos pinned to a phase are ALWAYS kept regardless of score —
 * those are operator-intentional documentation, not portfolio shots.
 *
 * Net effect: a project with 400 photos shrinks to ≤ 6 × 12 = 72
 * portal-tagged photos plus all phase-pinned ones, which keeps the
 * PDF and ZIP digestible without losing the operator-curated story.
 */
const CURATION_LIMIT_PER_TAG = 12;

type PhotoCuration = HomeRecordSnapshotV1['photos'][number];
type RawPhotoRow = Record<string, unknown>;

function curatePhotos(rows: RawPhotoRow[]): PhotoCuration[] {
  // Normalize each row to the snapshot shape first.
  const normalized: Array<PhotoCuration & { _score: number }> = rows.map((row) => ({
    id: row.id as string,
    storage_path: row.storage_path as string,
    caption: (row.caption as string | null) ?? null,
    portal_tags: ((row.portal_tags as string[] | null) ?? []) as PortalPhotoTag[],
    taken_at: (row.taken_at as string | null) ?? null,
    phase_id: (row.phase_id as string | null) ?? null,
    _score: typeof row.ai_showcase_score === 'number' ? (row.ai_showcase_score as number) : 0,
  }));

  // Always keep phase-pinned photos. We'll union them with the
  // tag-curated set at the end.
  const phasePinnedIds = new Set(normalized.filter((p) => p.phase_id != null).map((p) => p.id));

  // Bucket + cap per tag. A photo with multiple tags can survive via
  // any one of them; we union the IDs.
  const survivingIds = new Set<string>(phasePinnedIds);
  const buckets = new Map<PortalPhotoTag, typeof normalized>();
  for (const p of normalized) {
    for (const tag of p.portal_tags) {
      const list = buckets.get(tag) ?? [];
      list.push(p);
      buckets.set(tag, list);
    }
  }
  for (const [, list] of buckets.entries()) {
    list.sort((a, b) => {
      // Higher score first; ties broken by recent-taken-at first.
      if (b._score !== a._score) return b._score - a._score;
      const ta = a.taken_at ? Date.parse(a.taken_at) : 0;
      const tb = b.taken_at ? Date.parse(b.taken_at) : 0;
      return tb - ta;
    });
    for (const p of list.slice(0, CURATION_LIMIT_PER_TAG)) {
      survivingIds.add(p.id);
    }
  }

  // Return the surviving photos, preserving the original order
  // (taken_at ascending) so the storyline reads chronologically.
  return normalized.filter((p) => survivingIds.has(p.id)).map(({ _score, ...rest }) => rest);
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
    .select('id, name, status, started_at, completed_at')
    .eq('project_id', projectId)
    .order('display_order', { ascending: true });

  // Selections.
  const { data: selectionRows } = await supabase
    .from('project_selections')
    .select(
      'room, category, brand, name, code, finish, supplier, sku, warranty_url, notes, allowance_cents, actual_cost_cents',
    )
    .eq('project_id', projectId)
    .order('room', { ascending: true })
    .order('display_order', { ascending: true });

  // Photos — homeowner-visible AND either tagged for the gallery or
  // pinned to a phase. Phase-only photos still need to ride along so
  // the Home Record timeline can render them.
  //
  // Auto-curate: pull ai_showcase_score so we can rank within each
  // portal_tag bucket and cap to CURATION_LIMIT_PER_TAG below. Keeps
  // the package digestible without losing the best shots; phase-
  // pinned photos always pass through (they're operator-intentional).
  const { data: photoRows } = await supabase
    .from('photos')
    .select('id, storage_path, caption, portal_tags, taken_at, phase_id, ai_showcase_score')
    .eq('project_id', projectId)
    .eq('client_visible', true)
    .is('deleted_at', null)
    .or('portal_tags.neq.{},phase_id.not.is.null')
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
      id: (row as Record<string, unknown>).id as string,
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
        allowance_cents: (r.allowance_cents as number | null) ?? null,
        actual_cost_cents: (r.actual_cost_cents as number | null) ?? null,
      };
    }),
    photos: curatePhotos(photoRows ?? []),
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

/**
 * Generate the ZIP archive version of a home record. Reads the snapshot,
 * fetches every client-visible photo + document by signed URL, includes
 * the existing PDF (if generated), wraps everything in a folder layout
 * with a README.txt, and uploads to the `home-record-zips` bucket.
 *
 * Unlike the PDF, the ZIP is durably permanent — file copies inside
 * the archive don't depend on Storage signed URLs, so the homeowner
 * can save the ZIP forever and never lose access.
 *
 * Latency: this can be the slowest action in the pipeline (one fetch
 * per photo + per document, plus archive compression). The project
 * detail page already exports `maxDuration = 60` which covers a
 * typical residential reno (≤ 100 photos, ≤ 50 docs at 1-3 MB each).
 * Larger projects may need a background-job approach in Slice 6d.
 */
export type HomeRecordZipActionResult =
  | { ok: true; signedUrl: string }
  | { ok: false; error: string };

export async function generateHomeRecordZipAction(
  projectId: string,
): Promise<HomeRecordZipActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { data: row } = await supabase
    .from('home_records')
    .select('id, slug, snapshot, pdf_path')
    .eq('project_id', projectId)
    .maybeSingle();
  if (!row) return { ok: false, error: 'Generate the Home Record first.' };

  const r = row as Record<string, unknown>;
  const snapshot = r.snapshot as HomeRecordSnapshotV1;
  const slug = r.slug as string;
  const homeRecordId = r.id as string;
  const pdfPath = (r.pdf_path as string | null) ?? null;

  const admin = createAdminClient();

  // Fetch every photo (admin → bypass RLS).
  const photoBundle: ZipPhoto[] = [];
  if (snapshot.photos.length > 0) {
    const { data: signed } = await admin.storage.from('photos').createSignedUrls(
      snapshot.photos.map((p) => p.storage_path),
      600,
    );
    for (const entry of signed ?? []) {
      if (!entry.path || !entry.signedUrl) continue;
      try {
        const res = await fetch(entry.signedUrl);
        if (!res.ok) continue;
        const bytes = Buffer.from(await res.arrayBuffer());
        // For each tag the photo is in, emit a ZipPhoto entry — the
        // builder routes by tag folder.
        const photoMeta = snapshot.photos.find((p) => p.storage_path === entry.path);
        if (!photoMeta) continue;
        const filename = photoMeta.storage_path.split('/').pop() ?? 'photo.jpg';
        for (const tag of photoMeta.portal_tags) {
          photoBundle.push({
            storage_path: entry.path,
            bytes,
            filename,
            tag,
          });
        }
      } catch {
        // Skip — better than failing the whole archive.
      }
    }
  }

  // Fetch every document.
  const docBundle: ZipDoc[] = [];
  if (snapshot.documents.length > 0) {
    const { data: signed } = await admin.storage.from('project-docs').createSignedUrls(
      snapshot.documents.map((d) => d.storage_path),
      600,
    );
    for (const entry of signed ?? []) {
      if (!entry.path || !entry.signedUrl) continue;
      try {
        const res = await fetch(entry.signedUrl);
        if (!res.ok) continue;
        const bytes = Buffer.from(await res.arrayBuffer());
        const docMeta = snapshot.documents.find((d) => d.storage_path === entry.path);
        if (!docMeta) continue;
        // Use the document title as the filename (with the extension
        // off the storage path) — friendlier than the random storage
        // basename when the homeowner extracts the ZIP.
        const ext = entry.path.split('.').pop() ?? 'pdf';
        const filenameBase = docMeta.title.replace(/[^A-Za-z0-9 _.-]/g, '').trim() || 'document';
        const filename = `${filenameBase}.${ext}`;
        docBundle.push({
          storage_path: entry.path,
          bytes,
          filename,
          type: docMeta.type,
        });
      } catch {
        // Skip
      }
    }
  }

  // Optionally pull the PDF in.
  let pdfBytes: Buffer | null = null;
  if (pdfPath) {
    const { data: signed } = await admin.storage
      .from('home-record-pdfs')
      .createSignedUrl(pdfPath, 600);
    if (signed?.signedUrl) {
      try {
        const res = await fetch(signed.signedUrl);
        if (res.ok) pdfBytes = Buffer.from(await res.arrayBuffer());
      } catch {
        // Skip — README will note that the PDF wasn't included.
      }
    }
  }

  let zipBytes: Buffer;
  try {
    zipBytes = await generateHomeRecordZip(snapshot, photoBundle, docBundle, pdfBytes);
  } catch (e) {
    return {
      ok: false,
      error: `ZIP generation failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const storagePath = `${tenant.id}/${projectId}/${slug}.zip`;
  const { error: upErr } = await supabase.storage
    .from('home-record-zips')
    .upload(storagePath, zipBytes, {
      contentType: 'application/zip',
      upsert: true,
    });
  if (upErr) return { ok: false, error: `Upload failed: ${upErr.message}` };

  const { error: updErr } = await supabase
    .from('home_records')
    .update({ zip_path: storagePath })
    .eq('id', homeRecordId);
  if (updErr) return { ok: false, error: updErr.message };

  const { data: signed } = await supabase.storage
    .from('home-record-zips')
    .createSignedUrl(storagePath, 3600);

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, signedUrl: signed?.signedUrl ?? '' };
}

/**
 * Email the Home Record to the homeowner. Slice 6d.
 *
 * Sends a single branded email containing whichever of the three
 * delivery formats are ready: the permanent web link (always),
 * Download PDF (if pdf_path is set), Download ZIP (if zip_path is
 * set). Updates `home_records.emailed_at` and `emailed_to` on
 * success. Re-running re-sends and re-stamps.
 *
 * The email goes "From: <Business Name> via HeyHenry <noreply@…>"
 * with Reply-To set to the tenant's contact email — same envelope as
 * quote/CO emails (sendEmail handles it via tenantId).
 */
export type HomeRecordEmailActionResult =
  | { ok: true; emailedTo: string }
  | { ok: false; error: string };

export async function emailHomeRecordAction(
  projectId: string,
  options?: { overrideEmail?: string },
): Promise<HomeRecordEmailActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { data: row } = await supabase
    .from('home_records')
    .select('id, slug, snapshot, pdf_path, zip_path')
    .eq('project_id', projectId)
    .maybeSingle();
  if (!row) return { ok: false, error: 'Generate the Home Record first.' };

  const r = row as Record<string, unknown>;
  const snapshot = r.snapshot as HomeRecordSnapshotV1;
  const slug = r.slug as string;
  const homeRecordId = r.id as string;
  const hasPdf = Boolean(r.pdf_path);
  const hasZip = Boolean(r.zip_path);

  const to = (options?.overrideEmail ?? snapshot.customer.email ?? '').trim();
  if (!to) {
    return {
      ok: false,
      error:
        'No homeowner email on file. Add one to the contact record (or pass an override) and try again.',
    };
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.heyhenry.io';
  const webUrl = `${baseUrl}/home-record/${slug}`;
  const pdfUrl = `${baseUrl}/home-record/${slug}/download`;
  const zipUrl = `${baseUrl}/home-record/${slug}/download-zip`;

  const customerFirstName = (snapshot.customer.name ?? '').split(/\s+/)[0] || 'there';
  const projectName = snapshot.project.name;
  const contractor = snapshot.contractor.name;

  const subject = `Your Home Record for ${projectName}`;

  // Plain HTML — minimal styling, deliverability-friendly. Renders
  // cleanly in Gmail / Apple Mail / Outlook without extra dependencies.
  const linkBlocks: string[] = [];
  linkBlocks.push(
    `<p><a href="${webUrl}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open your Home Record</a></p>`,
  );
  if (hasPdf) {
    linkBlocks.push(
      `<p style="margin:6px 0;"><a href="${pdfUrl}" style="color:#2563eb;text-decoration:underline;">Download the PDF version →</a></p>`,
    );
  }
  if (hasZip) {
    linkBlocks.push(
      `<p style="margin:6px 0;"><a href="${zipUrl}" style="color:#2563eb;text-decoration:underline;">Download everything as a ZIP archive →</a></p>`,
    );
  }

  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#222;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
          <tr>
            <td style="padding:28px 28px 20px;">
              <p style="margin:0 0 12px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#888;">Home Record</p>
              <h1 style="margin:0 0 8px;font-size:22px;line-height:1.25;color:#111;">${escapeHtml(projectName)}</h1>
              <p style="margin:0;color:#666;font-size:14px;">From ${escapeHtml(contractor)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 24px;">
              <p style="margin:0 0 14px;font-size:15px;line-height:1.5;color:#222;">Hi ${escapeHtml(customerFirstName)},</p>
              <p style="margin:0 0 14px;font-size:15px;line-height:1.5;color:#222;">Your Home Record is ready — a permanent record of your project. Phases, photos (including everything we photographed behind the walls), paint codes, fixtures, warranties, and the change orders we worked through together.</p>
              <p style="margin:0 0 18px;font-size:15px;line-height:1.5;color:#222;">Save it somewhere safe — you'll want it for repairs, insurance, future renovations, or whenever you sell.</p>
              ${linkBlocks.join('\n')}
              <p style="margin:18px 0 0;font-size:13px;line-height:1.5;color:#888;">The web link works forever and stays current. The PDF and ZIP are dated snapshots — feel free to download them now and tuck them somewhere offline.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 28px 24px;border-top:1px solid #eee;">
              <p style="margin:0;font-size:12px;color:#888;">Thanks again — ${escapeHtml(contractor)}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

  const { sendEmail } = await import('@/lib/email/send');
  const result = await sendEmail({ to, subject, html, tenantId: tenant.id });
  if (!result.ok) {
    return { ok: false, error: result.error ?? 'Email send failed.' };
  }

  await supabase
    .from('home_records')
    .update({ emailed_at: new Date().toISOString(), emailed_to: to })
    .eq('id', homeRecordId);

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, emailedTo: to };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
