'use server';

/**
 * PIPEDA-compliant data export.
 *
 * Queries all tenant-scoped tables, formats each as CSV, bundles into a ZIP,
 * uploads to Supabase Storage (`exports/{tenant_id}/{export_id}.zip`), creates
 * a `data_exports` row, and returns a signed download URL (7-day expiry).
 */

import archiver from 'archiver';
import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { guardMfaForSensitiveAction } from '@/lib/auth/mfa-enforcement';
import { reportError } from '@/lib/error-reporting';
import { createClient } from '@/lib/supabase/server';

export type ExportActionResult =
  | { ok: true; downloadUrl: string; exportId: string }
  | { ok: false; error: string };

/** Convert an array of objects to CSV string. */
function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const csvEscape = (val: unknown): string => {
    const s = val === null || val === undefined ? '' : String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(',')),
  ];
  return lines.join('\n');
}

/** Tables to include in the export. List intentionally errs on the side of
 *  inclusion — GDPR Article 20 (portability) means anything tenant-scoped
 *  belongs in the dump. New tables added since this list was first written
 *  should be appended here. */
const EXPORT_TABLES = [
  // Core entities
  'customers',
  'quotes',
  'quote_line_items',
  'quote_surfaces',
  'jobs',
  'photos',
  'invoices',
  'todos',
  'worklog_entries',
  'catalog_items',
  // Renovation / project vertical (added 2026-05 for GDPR completeness)
  'projects',
  'project_buckets',
  'project_notes',
  'project_assignments',
  'project_scope_snapshots',
  // Membership + ops
  'tenant_members',
  'change_orders',
  'tasks',
  'expenses',
  'time_entries',
  'worker_invoices',
  'worker_profiles',
] as const;

export async function requestExportAction(): Promise<ExportActionResult> {
  const block = await guardMfaForSensitiveAction();
  if (block) return block;

  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();

  try {
    // Query all tenant-scoped tables (RLS enforces tenant isolation).
    const tableData: Record<string, Record<string, unknown>[]> = {};

    for (const table of EXPORT_TABLES) {
      const { data, error } = await supabase.from(table).select('*');
      if (error) {
        reportError(error, { table, tenantId: tenant.id });
        tableData[table] = [];
      } else {
        tableData[table] = (data ?? []) as Record<string, unknown>[];
      }
    }

    // Build ZIP in memory using archiver.
    const chunks: Buffer[] = [];
    const archive = archiver('zip', { zlib: { level: 9 } });

    const bufferPromise = new Promise<Buffer>((resolve, reject) => {
      archive.on('data', (chunk: Buffer) => chunks.push(chunk));
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', reject);
    });

    for (const table of EXPORT_TABLES) {
      const csv = toCsv(tableData[table]);
      archive.append(csv || '(no data)', { name: `${table}.csv` });
    }

    await archive.finalize();
    const zipBuffer = await bufferPromise;

    // Create data_exports row first to get the ID.
    const { data: exportRow, error: insertErr } = await supabase
      .from('data_exports')
      .insert({
        tenant_id: tenant.id,
        user_id: (await supabase.auth.getUser()).data.user?.id,
        status: 'in_progress',
      })
      .select('id')
      .single();

    if (insertErr || !exportRow) {
      reportError(insertErr, { tenantId: tenant.id });
      return { ok: false, error: insertErr?.message ?? 'Failed to create export record.' };
    }

    const exportId = exportRow.id as string;
    const storagePath = `${tenant.id}/${exportId}.zip`;

    // Upload to Supabase Storage.
    const { error: uploadErr } = await supabase.storage
      .from('exports')
      .upload(storagePath, zipBuffer, {
        contentType: 'application/zip',
        upsert: false,
      });

    if (uploadErr) {
      reportError(uploadErr, { tenantId: tenant.id, exportId });
      await supabase
        .from('data_exports')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', exportId);
      return { ok: false, error: `Upload failed: ${uploadErr.message}` };
    }

    // Create a signed URL (7-day expiry).
    const SEVEN_DAYS = 7 * 24 * 60 * 60;
    const { data: signedData, error: signErr } = await supabase.storage
      .from('exports')
      .createSignedUrl(storagePath, SEVEN_DAYS);

    if (signErr || !signedData?.signedUrl) {
      reportError(signErr, { tenantId: tenant.id, exportId });
      return { ok: false, error: 'Export uploaded but failed to create download link.' };
    }

    const expiresAt = new Date(Date.now() + SEVEN_DAYS * 1000).toISOString();

    // Update the export row with the download URL.
    await supabase
      .from('data_exports')
      .update({
        status: 'ready',
        download_url: signedData.signedUrl,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq('id', exportId);

    // Worklog entry.
    await supabase.from('worklog_entries').insert({
      tenant_id: tenant.id,
      entry_type: 'system',
      title: 'Data export completed',
      body: 'Full data export generated. Download link expires in 7 days.',
      related_type: null,
      related_id: null,
    });

    // Audit trail (compliance — proves the data was exported under MFA).
    const userId = (await supabase.auth.getUser()).data.user?.id ?? null;
    await supabase
      .from('audit_log')
      .insert({
        tenant_id: tenant.id,
        user_id: userId,
        action: 'tenant.data_exported',
        resource_type: 'data_export',
        resource_id: exportId,
        metadata_json: { tables: EXPORT_TABLES.length, expires_at: expiresAt },
      })
      .then(({ error }) => {
        if (error) console.warn('[export] audit log insert failed:', error.message);
      });

    revalidatePath('/settings');
    return { ok: true, downloadUrl: signedData.signedUrl, exportId };
  } catch (err) {
    reportError(err, { tenantId: tenant.id });
    return { ok: false, error: 'An unexpected error occurred during export.' };
  }
}
