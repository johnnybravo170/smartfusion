'use server';

/**
 * V1 inbound-email actions are gone — the universal /inbox/intake surface
 * in `src/server/actions/inbox-intake.ts` replaces them. The one action
 * that survives is `rejectInboundEmailAction` (still used by the legacy
 * card during the transition; FLIP deletes the legacy surface). It now
 * just stamps `status='bounced'` since the V1 'rejected' status is gone.
 */

import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export type InboundEmailResult = { ok: true; id: string } | { ok: false; error: string };

/** Operator dismisses a legacy inbound email envelope. */
export async function rejectInboundEmailAction(emailId: string): Promise<InboundEmailResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('inbound_emails')
    .update({ status: 'bounced', processed_at: new Date().toISOString() })
    .eq('id', emailId);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/inbox/intake');
  return { ok: true, id: emailId };
}
