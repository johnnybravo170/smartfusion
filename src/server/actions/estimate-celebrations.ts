'use server';

/**
 * Dismiss the "🎉 customer just opened your estimate" card. Marks every
 * unacknowledged estimate_viewed event for this project as acknowledged,
 * not just the one the card was rendered for — otherwise a second view
 * landing mid-session would immediately resurface the card.
 */

import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export type AckResult = { ok: true } | { ok: false; error: string };

export async function acknowledgeEstimateCelebrationAction(input: {
  projectId: string;
}): Promise<AckResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  if (!input.projectId) return { ok: false, error: 'Missing projectId.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('project_events')
    .update({ acknowledged_at: new Date().toISOString() })
    .eq('tenant_id', tenant.id)
    .eq('project_id', input.projectId)
    .eq('kind', 'estimate_viewed')
    .is('acknowledged_at', null);

  if (error) return { ok: false, error: error.message };

  revalidatePath('/dashboard');
  return { ok: true };
}
