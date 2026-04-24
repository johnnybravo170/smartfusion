/**
 * Provider factory.
 *
 * Every feature MUST obtain providers through these functions. Direct SDK
 * imports in feature code defeat the region routing and hot-swap goals.
 *
 * The factory caches instances per region. Region is resolved from the
 * tenant row; callers pass `tenantId` (the common case) or `region`
 * directly (platform admin / webhook handlers).
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { StripeConnectPaymentProvider } from './payments/stripe-connect';
import { type CountryCode, getTaxProviderForCountry } from './tax/factory';
import type { PaymentProvider, TaxProvider } from './types';

const paymentProviders = new Map<string, PaymentProvider>();

async function resolveTenant(tenantId: string): Promise<{ region: string; country: CountryCode }> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('tenants')
    .select('region, country')
    .eq('id', tenantId)
    .single();
  if (error || !data) {
    throw new Error(`Failed to resolve tenant ${tenantId}`);
  }
  return {
    region: data.region as string,
    country: ((data.country as string) ?? 'CA') as CountryCode,
  };
}

export async function getPaymentProvider(tenantId: string): Promise<PaymentProvider> {
  const { region } = await resolveTenant(tenantId);
  return getPaymentProviderForRegion(region);
}

export function getPaymentProviderForRegion(region: string): PaymentProvider {
  const existing = paymentProviders.get(region);
  if (existing) return existing;
  // Single provider per region today. When the US Stripe platform account
  // lands (kanban card ce0f355d), dispatch on region here — CA region uses
  // the Canadian platform keys, US region uses the US platform keys.
  const provider = new StripeConnectPaymentProvider(region);
  paymentProviders.set(region, provider);
  return provider;
}

/**
 * Country-aware tax provider. CA tenants get the Canadian impl;
 * US tenants get the stub that throws "not yet supported" until the
 * Stripe Tax card (45f3c3d8) ships.
 */
export async function getTaxProvider(tenantId: string): Promise<TaxProvider> {
  const { country } = await resolveTenant(tenantId);
  return getTaxProviderForCountry(country);
}
