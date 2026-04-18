'use server';

/**
 * Server actions for tenant settings.
 *
 * Includes slug management for the public quote link.
 */

import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { slugSchema } from '@/lib/validators/lead';

export async function updateQuoteSettingsAction(input: {
  quote_validity_days: number;
}): Promise<{ ok: boolean; error?: string }> {
  const days = Math.round(input.quote_validity_days);
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    return { ok: false, error: 'Quote validity must be between 1 and 365 days.' };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();

  const { error } = await supabase
    .from('tenants')
    .update({
      quote_validity_days: days,
      updated_at: new Date().toISOString(),
    })
    .eq('id', tenant.id);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath('/settings');
  return { ok: true };
}

export async function updateTenantSlugAction(
  slug: string,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = slugSchema.safeParse(slug);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid slug.' };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();

  // Check uniqueness (another tenant may already have this slug).
  const { data: existing } = await supabase
    .from('tenants')
    .select('id')
    .eq('slug', parsed.data)
    .neq('id', tenant.id)
    .maybeSingle();

  if (existing) {
    return { ok: false, error: 'This URL is already taken. Try a different one.' };
  }

  const { error } = await supabase
    .from('tenants')
    .update({ slug: parsed.data, updated_at: new Date().toISOString() })
    .eq('id', tenant.id);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath('/settings');
  return { ok: true };
}
