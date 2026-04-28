'use server';

/**
 * Server actions for tenant-level switching/cosmetics.
 *
 * `switchActiveTenantAction` flips the caller's active membership via the
 * `set_active_tenant_member` SECURITY DEFINER RPC (migration 0143). The
 * RPC verifies the caller actually belongs to the target tenant before
 * touching any rows.
 */

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export type SwitchTenantResult = { ok: true } | { ok: false; error: string };

export async function switchActiveTenantAction(input: {
  tenantId: string;
}): Promise<SwitchTenantResult> {
  if (!input?.tenantId) return { ok: false, error: 'Missing tenantId.' };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const { error } = await supabase.rpc('set_active_tenant_member', {
    target_tenant_id: input.tenantId,
  });
  if (error) return { ok: false, error: error.message };

  // Nuke every cached server-rendered page; the next render reads the
  // newly-active tenant via current_tenant_id().
  revalidatePath('/', 'layout');
  return { ok: true };
}
