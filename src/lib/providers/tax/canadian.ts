/**
 * Canadian tax provider.
 *
 * Resolution order for rates:
 *   1. If `tenants.province` is set, use the province-default rates from
 *      `src/lib/tax/provinces.ts`. This is the preferred path.
 *   2. Otherwise, fall back to the tenant-row overrides `gst_rate` and
 *      `pst_rate`. Legacy tenants with no province set keep working.
 *
 * Every tax computation in the app should go through this provider —
 * direct reads of `gst_rate`/`pst_rate` are being migrated out. See the
 * `helpers.ts` AI tool helper which used to read directly.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { getRatesForProvince } from '@/lib/tax/provinces';
import type { TaxComputation, TaxExtraction, TaxProvider, TenantTaxContext } from '../types';

export class CanadianTaxProvider implements TaxProvider {
  readonly name = 'canadian';

  async getContext(tenantId: string): Promise<TenantTaxContext> {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from('tenants')
      .select('province, gst_rate, pst_rate')
      .eq('id', tenantId)
      .single();
    if (error || !data) {
      throw new Error(`Failed to load tax rates for tenant ${tenantId}`);
    }

    const province = (data.province as string | null) ?? null;
    const provinceRates = getRatesForProvince(province);

    if (provinceRates) {
      const total = provinceRates.gstRate + provinceRates.pstRate;
      return {
        gstRate: provinceRates.gstRate,
        pstRate: provinceRates.pstRate,
        totalRate: total,
        breakdown: provinceRates.breakdown,
        provinceCode: provinceRates.code,
        summaryLabel: provinceRates.breakdown.map((b) => b.label).join(' + '),
      };
    }

    // Legacy fallback — province unset, use per-tenant rate overrides.
    const gstRate = Number(data.gst_rate ?? 0);
    const pstRate = Number(data.pst_rate ?? 0);
    const total = gstRate + pstRate;
    const breakdown: Array<{ label: string; rate: number }> = [];
    if (gstRate > 0) breakdown.push({ label: `GST ${(gstRate * 100).toFixed(0)}%`, rate: gstRate });
    if (pstRate > 0) breakdown.push({ label: `PST ${(pstRate * 100).toFixed(0)}%`, rate: pstRate });

    return {
      gstRate,
      pstRate,
      totalRate: total,
      breakdown,
      provinceCode: null,
      summaryLabel: breakdown.length ? breakdown.map((b) => b.label).join(' + ') : 'No tax',
    };
  }

  async computeTax(input: { subtotalCents: number; tenantId: string }): Promise<TaxComputation> {
    const ctx = await this.getContext(input.tenantId);

    const breakdown = ctx.breakdown.map((b) => ({
      label: b.label,
      rate: b.rate,
      amountCents: Math.round(input.subtotalCents * b.rate),
    }));
    const taxCents = breakdown.reduce((s, b) => s + b.amountCents, 0);

    return {
      subtotalCents: input.subtotalCents,
      taxCents,
      totalCents: input.subtotalCents + taxCents,
      breakdown,
    };
  }

  async extractTax(input: { totalCents: number; tenantId: string }): Promise<TaxExtraction> {
    const ctx = await this.getContext(input.tenantId);

    // Inclusive rate math: subtotal = total / (1 + totalRate).
    // If no tax is configured, pass the whole thing through as subtotal.
    if (ctx.totalRate <= 0) {
      return {
        totalCents: input.totalCents,
        subtotalCents: input.totalCents,
        taxCents: 0,
        breakdown: [],
      };
    }

    const subtotalCents = Math.round(input.totalCents / (1 + ctx.totalRate));
    const breakdown = ctx.breakdown.map((b) => ({
      label: b.label,
      rate: b.rate,
      amountCents: Math.round(subtotalCents * b.rate),
    }));
    // Rounding drift: adjust the largest line so sum matches input.totalCents exactly.
    const sumBreakdown = breakdown.reduce((s, b) => s + b.amountCents, 0);
    const drift = input.totalCents - subtotalCents - sumBreakdown;
    if (drift !== 0 && breakdown.length > 0) {
      const biggest = breakdown.reduce((a, b) => (a.amountCents > b.amountCents ? a : b));
      biggest.amountCents += drift;
    }
    const taxCents = breakdown.reduce((s, b) => s + b.amountCents, 0);

    return {
      totalCents: input.totalCents,
      subtotalCents: input.totalCents - taxCents,
      taxCents,
      breakdown,
    };
  }
}

/**
 * Singleton convenience — callers who don't need tenant-aware DI can
 * just import `canadianTax` and call its methods directly.
 */
export const canadianTax = new CanadianTaxProvider();
