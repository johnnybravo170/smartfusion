'use server';

/**
 * Tenant-level security settings. Currently one knob:
 *   - `require_mfa_for_all_members` — owner-only toggle.
 *
 * Owner check is enforced at the app layer (role pulled from
 * `getCurrentTenant`). RLS on the underlying tenants update still applies.
 */

import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export type TenantSecurityResult = { ok: true } | { ok: false; error: string };

export async function setRequireMfaForAllMembersAction(input: {
  value: boolean;
}): Promise<TenantSecurityResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  if (tenant.member.role !== 'owner') {
    return { ok: false, error: 'Only the tenant owner can change this setting.' };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from('tenants')
    .update({
      require_mfa_for_all_members: !!input.value,
      updated_at: new Date().toISOString(),
    })
    .eq('id', tenant.id);

  if (error) return { ok: false, error: error.message };

  revalidatePath('/settings/security');
  return { ok: true };
}
