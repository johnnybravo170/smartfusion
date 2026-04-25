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
