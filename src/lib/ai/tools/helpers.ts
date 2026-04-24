import { canadianTax } from '@/lib/providers/tax/canadian';
import { createClient } from '@/lib/supabase/server';

/**
 * Reads the effective tax rate for a tenant.
 *
 * Priority:
 *  1. `tenant_prefs.invoicing.tax_rate` (explicit AI-tool override — kept
 *     for backwards-compat with quote/invoice AI tools that support a
 *     per-tenant override).
 *  2. `CanadianTaxProvider.getContext()` — province-aware, falls back to
 *     the tenant's gst_rate/pst_rate row if province isn't set.
 *  3. 0.05 (safety default if everything fails).
 */
export async function getTaxRate(tenantId: string): Promise<number> {
  try {
    const supabase = await createClient();

    const { data: pref } = await supabase
      .from('tenant_prefs')
      .select('data')
      .eq('tenant_id', tenantId)
      .eq('namespace', 'invoicing')
      .maybeSingle();

    if (pref?.data && typeof (pref.data as Record<string, unknown>).tax_rate === 'number') {
      return (pref.data as Record<string, unknown>).tax_rate as number;
    }

    const ctx = await canadianTax.getContext(tenantId);
    return ctx.totalRate;
  } catch {
    return 0.05;
  }
}
