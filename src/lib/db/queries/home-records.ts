/**
 * Home Record queries + the canonical snapshot shape. Slice 6a of the
 * Customer Portal & Home Record build.
 *
 * The snapshot is a denormalized copy of the project at close-out time,
 * plus contractor / customer / project header info. It powers the
 * permanent `/home-record/<slug>` page and (in Slice 6b/c) the PDF and
 * ZIP exports.
 *
 * Storage paths are stored as-is; URLs are re-signed at render time.
 * See migration 0127 header for the durability caveat.
 */

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import type { PortalPhotoTag } from '@/lib/validators/portal-photo';
import type { DocumentType } from '@/lib/validators/project-document';
import type { SelectionCategory } from '@/lib/validators/project-selection';

export type HomeRecordSnapshotV1 = {
  version: 1;
  generated_at: string;
  contractor: {
    name: string;
    logo_url: string | null;
  };
  customer: {
    name: string | null;
    address: string | null;
    email: string | null;
    phone: string | null;
  };
  project: {
    name: string;
    description: string | null;
    start_date: string | null;
    target_end_date: string | null;
  };
  phases: Array<{
    name: string;
    status: 'upcoming' | 'in_progress' | 'complete';
    started_at: string | null;
    completed_at: string | null;
  }>;
  selections: Array<{
    room: string;
    category: SelectionCategory;
    brand: string | null;
    name: string | null;
    code: string | null;
    finish: string | null;
    supplier: string | null;
    sku: string | null;
    warranty_url: string | null;
    notes: string | null;
  }>;
  photos: Array<{
    id: string;
    storage_path: string;
    caption: string | null;
    portal_tags: PortalPhotoTag[];
    taken_at: string | null;
  }>;
  documents: Array<{
    type: DocumentType;
    title: string;
    storage_path: string;
    bytes: number | null;
    expires_at: string | null;
  }>;
  decisions: Array<{
    label: string;
    description: string | null;
    decided_value: string | null;
    decided_at: string | null;
    decided_by_customer: string | null;
  }>;
  change_orders: Array<{
    title: string;
    description: string;
    cost_impact_cents: number;
    timeline_impact_days: number;
    approved_at: string | null;
    approved_by_name: string | null;
  }>;
};

export type HomeRecordRow = {
  id: string;
  project_id: string;
  slug: string;
  snapshot: HomeRecordSnapshotV1;
  generated_at: string;
  pdf_path: string | null;
  zip_path: string | null;
  emailed_at: string | null;
  emailed_to: string | null;
};

/**
 * RLS-aware fetch — used by the operator's project detail page to know
 * whether a record exists yet ("Generate" vs "View / Regenerate").
 */
export const getHomeRecordForProject = cache(
  async (projectId: string): Promise<HomeRecordRow | null> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from('home_records')
      .select(
        'id, project_id, slug, snapshot, generated_at, pdf_path, zip_path, emailed_at, emailed_to',
      )
      .eq('project_id', projectId)
      .maybeSingle();
    return (data as unknown as HomeRecordRow) ?? null;
  },
);
