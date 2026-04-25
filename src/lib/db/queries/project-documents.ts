/**
 * Project document queries. Slice 5 of the Customer Portal build.
 */

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import type { DocumentType } from '@/lib/validators/project-document';

export type ProjectDocument = {
  id: string;
  project_id: string;
  type: DocumentType;
  title: string;
  storage_path: string;
  mime: string | null;
  bytes: number | null;
  supplier_id: string | null;
  expires_at: string | null;
  notes: string | null;
  client_visible: boolean;
  created_at: string;
};

export type ProjectDocumentWithUrl = ProjectDocument & { url: string | null };

const COLUMNS =
  'id, project_id, type, title, storage_path, mime, bytes, supplier_id, expires_at, notes, client_visible, created_at';

export const listDocumentsForProject = cache(
  async (projectId: string): Promise<ProjectDocumentWithUrl[]> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from('project_documents')
      .select(COLUMNS)
      .eq('project_id', projectId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    const rows = ((data ?? []) as unknown as ProjectDocument[]) ?? [];
    if (rows.length === 0) return [];

    // Sign URLs in one batch.
    const paths = rows.map((r) => r.storage_path);
    const { data: signed } = await supabase.storage
      .from('project-docs')
      .createSignedUrls(paths, 3600);
    const map = new Map<string, string>();
    for (const row of signed ?? []) {
      if (row.path && row.signedUrl) map.set(row.path, row.signedUrl);
    }
    return rows.map((row) => ({ ...row, url: map.get(row.storage_path) ?? null }));
  },
);

/**
 * Distinct sub-trade / vendor contacts associated with the project via
 * `project_documents.supplier_id`. Used to render the "Trade contacts"
 * subsection on the operator Documents tab and the homeowner portal.
 *
 * Returns at most one row per supplier — the latest doc the operator
 * uploaded from them is what shows up in the Documents list, the
 * supplier line up top is just contact info.
 */
export type ProjectSubContact = {
  id: string;
  name: string;
  kind: 'customer' | 'lead' | 'vendor' | 'sub' | 'agent' | 'inspector' | 'referral' | 'other';
  email: string | null;
  phone: string | null;
};

export async function listSubcontractorsForProject(
  projectId: string,
): Promise<ProjectSubContact[]> {
  const supabase = await createClient();
  const { data: docRows } = await supabase
    .from('project_documents')
    .select('supplier_id')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .not('supplier_id', 'is', null);
  const ids = Array.from(
    new Set(
      (docRows ?? [])
        .map((r) => (r as Record<string, unknown>).supplier_id as string | null)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  if (ids.length === 0) return [];

  const { data: contactRows } = await supabase
    .from('customers')
    .select('id, name, kind, email, phone')
    .in('id', ids)
    .is('deleted_at', null);
  return ((contactRows ?? []) as unknown as ProjectSubContact[])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Tenant-scoped picker source for the upload form's "Supplier" select.
 * Returns sub-trade and vendor contacts (the kinds operators usually
 * link a contract / warranty / inspection PDF to).
 */
export async function listSubAndVendorContactsForTenant(): Promise<ProjectSubContact[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('customers')
    .select('id, name, kind, email, phone')
    .in('kind', ['sub', 'vendor'])
    .is('deleted_at', null)
    .order('name', { ascending: true });
  return ((data ?? []) as unknown as ProjectSubContact[]) ?? [];
}
