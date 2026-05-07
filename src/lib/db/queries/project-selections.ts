/**
 * Per-room material selections. Slice 4 of the Customer Portal build.
 * Drives the Selections tab on the project detail page and the
 * read-only "Selections" section on /portal/<slug>; will be snapshotted
 * by Slice 6 (Home Record).
 */

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import type { SelectionCategory } from '@/lib/validators/project-selection';

export type ProjectSelectionPhotoRef = {
  photo_id: string;
  storage_path: string;
  caption?: string | null;
};

export type ProjectSelection = {
  id: string;
  project_id: string;
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
  photo_refs: ProjectSelectionPhotoRef[];
  /** Budget for this line, integer cents. Null = no allowance set. */
  allowance_cents: number | null;
  /** Actual cost incurred, integer cents. Null = not yet known. */
  actual_cost_cents: number | null;
  display_order: number;
  /** Who authored this row — operator (install spec) or customer (self-recorded). */
  created_by: 'operator' | 'customer';
  /** Single inline customer-uploaded image (path in photos bucket). */
  image_storage_path: string | null;
};

const COLUMNS =
  'id, project_id, room, category, brand, name, code, finish, supplier, sku, warranty_url, notes, photo_refs, allowance_cents, actual_cost_cents, display_order, created_by, image_storage_path';

export const listSelectionsForProject = cache(
  async (projectId: string): Promise<ProjectSelection[]> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from('project_selections')
      .select(COLUMNS)
      .eq('project_id', projectId)
      .order('room', { ascending: true })
      .order('display_order', { ascending: true });

    return ((data ?? []) as unknown as ProjectSelection[]).map((row) => ({
      ...row,
      photo_refs: Array.isArray(row.photo_refs) ? row.photo_refs : [],
    }));
  },
);

/** Group a flat list by room, preserving the room order (alphabetical). */
export function groupSelectionsByRoom(
  selections: ProjectSelection[],
): Array<{ room: string; items: ProjectSelection[] }> {
  const map = new Map<string, ProjectSelection[]>();
  for (const sel of selections) {
    const key = sel.room.trim() || 'Unsorted';
    const list = map.get(key) ?? [];
    list.push(sel);
    map.set(key, list);
  }
  return Array.from(map.entries()).map(([room, items]) => ({ room, items }));
}
