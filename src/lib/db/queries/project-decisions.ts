/**
 * Project decision queue queries. Slice 3 of the Customer Portal build.
 *
 * Decisions are operator-created prompts the homeowner needs to act on:
 * pick a paint color, approve an allowance bump, confirm tile layout,
 * etc. Each decision can carry reference photos and an optional due
 * date, and rides the same approval-code pattern as change_orders so
 * the SMS tap-to-approve flow (Slice 7) can plug in without a redesign.
 */

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';

export type ProjectDecisionStatus = 'pending' | 'decided' | 'dismissed';

export type ProjectDecisionPhotoRef = {
  photo_id: string;
  storage_path: string;
  caption?: string | null;
};

export type ProjectDecision = {
  id: string;
  project_id: string;
  label: string;
  description: string | null;
  due_date: string | null;
  status: ProjectDecisionStatus;
  decided_value: string | null;
  decided_at: string | null;
  decided_by_customer: string | null;
  photo_refs: ProjectDecisionPhotoRef[];
  approval_code: string | null;
  /** Empty = binary approve/decline. Non-empty = pick-one vote. */
  options: string[];
  created_at: string;
};

const COLUMNS =
  'id, project_id, label, description, due_date, status, decided_value, decided_at, decided_by_customer, photo_refs, approval_code, options, created_at';

export const listDecisionsForProject = cache(
  async (projectId: string): Promise<ProjectDecision[]> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from('project_decisions')
      .select(COLUMNS)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });
    return ((data ?? []) as unknown as ProjectDecision[]).map((row) => ({
      ...row,
      photo_refs: Array.isArray(row.photo_refs) ? row.photo_refs : [],
      options: Array.isArray(row.options) ? row.options.filter((o) => typeof o === 'string') : [],
    }));
  },
);
