/**
 * Queries for the estimate-snippet library. RLS-aware server client.
 */

import { createClient } from '@/lib/supabase/server';

export type EstimateSnippetRow = {
  id: string;
  tenant_id: string;
  label: string;
  body: string;
  is_default: boolean;
  display_order: number;
  created_at: string;
  updated_at: string;
};

const COLUMNS = 'id, tenant_id, label, body, is_default, display_order, created_at, updated_at';

export async function listEstimateSnippets(): Promise<EstimateSnippetRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('estimate_snippets')
    .select(COLUMNS)
    .order('display_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Failed to list snippets: ${error.message}`);
  return (data ?? []) as EstimateSnippetRow[];
}

export async function getEstimateSnippet(id: string): Promise<EstimateSnippetRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('estimate_snippets')
    .select(COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to load snippet: ${error.message}`);
  }
  return (data as EstimateSnippetRow | null) ?? null;
}
