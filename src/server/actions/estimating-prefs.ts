'use server';

/**
 * Tenant-level estimating preferences. v1 ships with a single knob —
 * default detail level for AI-generated scope scaffolds (Quick /
 * Standard / Detailed). The scope-scaffold action reads this pref
 * when no explicit detailLevel is passed in.
 *
 * Lives in `tenant_prefs.namespace='estimating'`. Same pattern as the
 * checklist hide-window setting — namespaced JSONB on tenant_prefs.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

export type EstimatingPrefsResult = { ok: true } | { ok: false; error: string };

const detailLevelSchema = z.object({
  detail_level: z.enum(['quick', 'standard', 'detailed']),
});

/**
 * Persist the operator's default detail level for AI scope scaffolds.
 * Per-quote override stays available on the generator dialog; this
 * sets the starting point for new quotes.
 */
export async function setEstimatingDetailLevelAction(
  input: Record<string, unknown>,
): Promise<EstimatingPrefsResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = detailLevelSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Pick quick, standard, or detailed.' };

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from('tenant_prefs')
    .select('data')
    .eq('tenant_id', tenant.id)
    .eq('namespace', 'estimating')
    .maybeSingle();

  const merged = {
    ...((existing?.data as Record<string, unknown> | null) ?? {}),
    detail_level: parsed.data.detail_level,
  };

  const { error } = await admin.from('tenant_prefs').upsert(
    {
      tenant_id: tenant.id,
      namespace: 'estimating',
      data: merged,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'tenant_id,namespace' },
  );
  if (error) return { ok: false, error: error.message };

  revalidatePath('/settings');
  return { ok: true };
}

/** Read the tenant's current detail-level preference (or defaults). */
export async function getEstimatingDetailLevel(): Promise<'quick' | 'standard' | 'detailed'> {
  const tenant = await getCurrentTenant();
  if (!tenant) return 'standard';

  const admin = createAdminClient();
  const { data } = await admin
    .from('tenant_prefs')
    .select('data')
    .eq('tenant_id', tenant.id)
    .eq('namespace', 'estimating')
    .maybeSingle();

  const stored = (data?.data as { detail_level?: string } | null)?.detail_level;
  if (stored === 'quick' || stored === 'detailed') return stored;
  return 'standard';
}
