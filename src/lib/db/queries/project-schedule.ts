/**
 * Project schedule (Gantt) queries.
 *
 * Tasks are the per-project Gantt rows. Tenant isolation runs through
 * `current_tenant_id()` in the `project_schedule_tasks` RLS policies;
 * application code never filters on `tenant_id`. Soft-deleted rows
 * (`deleted_at IS NOT NULL`) are filtered here for active-list reads —
 * audit / history queries can opt out.
 */

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';

export type ScheduleConfidence = 'rough' | 'firm';
export type ScheduleStatus = 'planned' | 'scheduled' | 'in_progress' | 'done';

export type ProjectScheduleTask = {
  id: string;
  project_id: string;
  name: string;
  trade_template_id: string | null;
  budget_category_id: string | null;
  phase_id: string | null;
  planned_start_date: string;
  planned_duration_days: number;
  actual_start_date: string | null;
  actual_end_date: string | null;
  status: ScheduleStatus;
  confidence: ScheduleConfidence;
  client_visible: boolean;
  display_order: number;
  notes: string | null;
};

const TASK_COLUMNS =
  'id, project_id, name, trade_template_id, budget_category_id, phase_id, planned_start_date, planned_duration_days, actual_start_date, actual_end_date, status, confidence, client_visible, display_order, notes';

/** RLS-aware list of active tasks for the operator-side Gantt view. */
export const listScheduleTasksForProject = cache(
  async (projectId: string): Promise<ProjectScheduleTask[]> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from('project_schedule_tasks')
      .select(TASK_COLUMNS)
      .eq('project_id', projectId)
      .is('deleted_at', null)
      .order('display_order', { ascending: true });
    return (data ?? []) as ProjectScheduleTask[];
  },
);
