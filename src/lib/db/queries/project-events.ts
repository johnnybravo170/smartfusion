import { createClient } from '@/lib/supabase/server';

export type ProjectEventRow = {
  id: string;
  project_id: string;
  tenant_id: string;
  kind: string;
  meta: Record<string, unknown>;
  actor: string | null;
  occurred_at: string;
};

export async function listProjectEvents(projectId: string, limit = 50): Promise<ProjectEventRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('project_events')
    .select('id, project_id, tenant_id, kind, meta, actor, occurred_at')
    .eq('project_id', projectId)
    .order('occurred_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to list project events: ${error.message}`);
  return (data ?? []) as ProjectEventRow[];
}

export type EstimateViewStats = {
  total: number;
  last_viewed_at: string | null;
  first_viewed_at: string | null;
};

export async function getEstimateViewStats(projectId: string): Promise<EstimateViewStats> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('public_page_views')
    .select('viewed_at')
    .eq('resource_type', 'estimate')
    .eq('resource_id', projectId)
    .order('viewed_at', { ascending: false });

  if (error) throw new Error(`Failed to load view stats: ${error.message}`);
  const rows = (data ?? []) as { viewed_at: string }[];
  return {
    total: rows.length,
    last_viewed_at: rows[0]?.viewed_at ?? null,
    first_viewed_at: rows[rows.length - 1]?.viewed_at ?? null,
  };
}
