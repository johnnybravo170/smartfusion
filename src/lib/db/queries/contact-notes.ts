/**
 * Queries for the `contact_notes` feed. RLS-aware server client.
 */

import { createClient } from '@/lib/supabase/server';

export type ContactNoteRow = {
  id: string;
  tenant_id: string;
  contact_id: string;
  author_type: 'operator' | 'worker' | 'henry' | 'customer' | 'system';
  author_id: string | null;
  body: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export async function listContactNotes(contactId: string): Promise<ContactNoteRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('contact_notes')
    .select(
      'id, tenant_id, contact_id, author_type, author_id, body, metadata, created_at, updated_at',
    )
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to list contact notes: ${error.message}`);
  }
  return (data ?? []) as ContactNoteRow[];
}
