/**
 * Time entry queries for project/job time tracking.
 */

import { createClient } from '@/lib/supabase/server';

export type TimeEntryRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  worker_profile_id: string | null;
  project_id: string | null;
  budget_category_id: string | null;
  /** Optional cost line tag. When set, labour rolls up to the line's
   *  per-line Spent column on the Budget tab. */
  cost_line_id: string | null;
  job_id: string | null;
  hours: number;
  hourly_rate_cents: number | null;
  notes: string | null;
  entry_date: string;
  created_at: string;
  updated_at: string;
};

export type TimeEntryFilters = {
  project_id?: string;
  job_id?: string;
  user_id?: string;
  budget_category_id?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
};

export async function listTimeEntries(filters: TimeEntryFilters = {}): Promise<TimeEntryRow[]> {
  const supabase = await createClient();
  const limit = filters.limit ?? 200;

  let query = supabase.from('time_entries').select('*');

  if (filters.project_id) query = query.eq('project_id', filters.project_id);
  if (filters.job_id) query = query.eq('job_id', filters.job_id);
  if (filters.user_id) query = query.eq('user_id', filters.user_id);
  if (filters.budget_category_id)
    query = query.eq('budget_category_id', filters.budget_category_id);
  if (filters.date_from) query = query.gte('entry_date', filters.date_from);
  if (filters.date_to) query = query.lte('entry_date', filters.date_to);

  const { data, error } = await query
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to list time entries: ${error.message}`);
  }
  return (data ?? []) as TimeEntryRow[];
}

export async function getTimeEntry(id: string): Promise<TimeEntryRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('time_entries')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to load time entry: ${error.message}`);
  }
  return data as TimeEntryRow | null;
}
