/**
 * Country-aware tax provider factory.
 *
 * Every tax computation in the app should resolve a provider through
 * this factory, not import a country-specific provider directly. That
 * way US launch flips on by changing `tenant.country` — not by hunting
 * through the codebase for hard-coded `canadianTax` imports.
 *
 * Current state (2026-04-23):
 *   - CA tenants → CanadianTaxProvider (full impl, province-aware)
 *   - US tenants → UsSalesTaxProvider (stub, throws on call)
 *
 * See US_EXPANSION_PLAN.md for the full architectural context.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import type { TaxProvider } from '../types';
import { canadianTax } from './canadian';
import { usSalesTax } from './us';

export type CountryCode = 'CA' | 'US';

export function getTaxProviderForCountry(country: CountryCode): TaxProvider {
  switch (country) {
    case 'CA':
      return canadianTax;
    case 'US':
      return usSalesTax;
    default: {
      // TS exhaustiveness check — adding a new country forces you to
      // update the switch before this file type-checks.
      const exhaustive: never = country;
      throw new Error(`Unsupported country: ${exhaustive}`);
    }
  }
}

/**
 * Resolve the right provider for a tenant by reading `tenants.country`
 * and dispatching. One admin round-trip; callers that already have the
 * tenant country in hand should prefer `getTaxProviderForCountry`.
 */
export async function getTaxProviderForTenant(tenantId: string): Promise<TaxProvider> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('tenants')
    .select('country')
    .eq('id', tenantId)
    .single();
  if (error || !data)
    throw new Error(`Failed to resolve tax provider: ${error?.message ?? 'tenant not found'}`);
  return getTaxProviderForCountry((data.country as CountryCode) ?? 'CA');
}
