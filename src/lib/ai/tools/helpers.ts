import { createClient } from '@/lib/supabase/server';

/**
 * Reads the effective tax rate for a tenant.
 *
 * Priority:
 *  1. tenant_prefs.invoicing.tax_rate (explicit override)
 *  2. tenants.gst_rate + tenants.pst_rate (combined from tenant row)
 *  3. 0.05 (platform default)
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

    const { data: tenant } = await supabase
      .from('tenants')
      .select('gst_rate, pst_rate')
      .eq('id', tenantId)
      .maybeSingle();

    if (tenant) {
      const gst = parseFloat(String(tenant.gst_rate ?? '0.05'));
      const pst = parseFloat(String(tenant.pst_rate ?? '0'));
      return gst + pst;
    }
  } catch {
    // fall through to default
  }
  return 0.05;
}
