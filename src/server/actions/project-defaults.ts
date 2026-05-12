'use server';

/**
 * Tenant-level defaults applied at project-create time.
 *
 * Today this is just the default management fee rate (Mike runs 18%
 * across every job, Jonathan runs something else — anchoring on a
 * tenant-level default avoids the contractor re-typing it on every
 * new project). Future additions live here: default customer view
 * mode, default budget category template, etc. — anything that
 * pre-populates the new-project form.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export type ProjectDefaultsResult = { ok: true } | { ok: false; error: string };

const mgmtFeeRateSchema = z.object({
  rate: z.coerce
    .number()
    .min(0, { message: 'Fee rate cannot be negative.' })
    .max(0.5, { message: 'Fee rate cannot exceed 50%.' }),
});

/**
 * Read the tenant's default mgmt fee rate. Falls back to 0.12 if the
 * tenant or column isn't reachable (matches the column default — same
 * answer that would have shipped before this setting existed).
 */
export async function getDefaultManagementFeeRate(): Promise<number> {
  const tenant = await getCurrentTenant();
  if (!tenant) return 0.12;

  const supabase = await createClient();
  const { data } = await supabase
    .from('tenants')
    .select('default_management_fee_rate')
    .eq('id', tenant.id)
    .single();

  const stored = data?.default_management_fee_rate;
  if (typeof stored === 'number' && Number.isFinite(stored)) return stored;
  if (typeof stored === 'string') {
    const parsed = Number.parseFloat(stored);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0.12;
}

/** Persist the tenant's default mgmt fee rate. Owner/admin only. */
export async function updateDefaultManagementFeeRateAction(
  input: z.input<typeof mgmtFeeRateSchema>,
): Promise<ProjectDefaultsResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  if (tenant.member.role !== 'owner' && tenant.member.role !== 'admin') {
    return { ok: false, error: 'Only owners and admins can change tenant defaults.' };
  }

  const parsed = mgmtFeeRateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid management fee rate.',
    };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from('tenants')
    .update({ default_management_fee_rate: parsed.data.rate })
    .eq('id', tenant.id);

  if (error) return { ok: false, error: error.message };

  revalidatePath('/settings');
  return { ok: true };
}
