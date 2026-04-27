'use server';

/**
 * Tenant-level automation toggles. All flags live under
 * `tenant_prefs(namespace='automation').data` as a single jsonb blob.
 *
 * Read helpers live in `src/lib/ar/system-sequences.ts` so the AR engine
 * can resolve them at enrollment time.
 */

import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

export type AutomationActionResult = { ok: true } | { ok: false; error: string };

export async function setAutoQuoteFollowupAction(
  enabled: boolean,
): Promise<AutomationActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const admin = createAdminClient();

  // Read existing namespace data so we don't blow away other automation flags.
  const { data: existing } = await admin
    .from('tenant_prefs')
    .select('data')
    .eq('tenant_id', tenant.id)
    .eq('namespace', 'automation')
    .maybeSingle();

  const merged = {
    ...((existing?.data as Record<string, unknown> | null) ?? {}),
    quote_followup_enabled: enabled,
  };

  const { error } = await admin.from('tenant_prefs').upsert(
    {
      tenant_id: tenant.id,
      namespace: 'automation',
      data: merged,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'tenant_id,namespace' },
  );

  if (error) return { ok: false, error: error.message };

  revalidatePath('/settings/automations');
  return { ok: true };
}
