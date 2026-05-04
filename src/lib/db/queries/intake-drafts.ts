/**
 * Read-side helpers for intake_drafts. RLS handles tenant scoping —
 * the queries just call through the request-scoped client.
 */

import type { ParsedIntake } from '@/lib/ai/intake-prompt';
import { createClient } from '@/lib/supabase/server';

export type IntakeDraftStatus =
  | 'pending'
  | 'transcribing'
  | 'extracting'
  | 'rethinking'
  | 'ready'
  | 'failed';

export type IntakeDraftRow = {
  id: string;
  status: IntakeDraftStatus;
  customer_name: string | null;
  pasted_text: string | null;
  transcript: string | null;
  ai_extraction: {
    v1: ParsedIntake | null;
    v2: ParsedIntake | null;
    active: 'v1' | 'v2';
  } | null;
  parsed_by: string | null;
  error_message: string | null;
  accepted_project_id: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Load a single draft by id. Returns null when missing or
 * cross-tenant (RLS denies the row).
 */
export async function loadIntakeDraft(id: string): Promise<IntakeDraftRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('intake_drafts')
    .select(
      'id, status, customer_name, pasted_text, transcript, ai_extraction, parsed_by, error_message, accepted_project_id, created_at, updated_at',
    )
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as IntakeDraftRow;
}
