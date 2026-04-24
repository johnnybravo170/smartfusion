/**
 * US sales tax provider — STUB.
 *
 * Intentionally throws on every call. US expansion is deferred (see
 * US_EXPANSION_PLAN.md). When the "Sales tax via Stripe Tax" card is
 * picked up, this file becomes the implementation: rate lookup by ZIP
 * via Stripe Tax, product-category codes for labour vs materials,
 * economic-nexus monitoring.
 *
 * The stub exists so that:
 *   - the factory in `./factory.ts` has something to return for US
 *     tenants without an import-time crash
 *   - if a US tenant somehow gets created before we ship the real
 *     impl, we fail loudly and explicitly rather than silently
 *     defaulting to Canadian tax
 */

import type { TaxComputation, TaxExtraction, TaxProvider, TenantTaxContext } from '../types';

const NOT_YET = 'US sales tax not yet supported — see US_EXPANSION_PLAN.md';

export class UsSalesTaxProvider implements TaxProvider {
  readonly name = 'us-sales-tax';

  async getContext(_tenantId: string): Promise<TenantTaxContext> {
    throw new Error(NOT_YET);
  }
  async computeTax(_input: { subtotalCents: number; tenantId: string }): Promise<TaxComputation> {
    throw new Error(NOT_YET);
  }
  async extractTax(_input: { totalCents: number; tenantId: string }): Promise<TaxExtraction> {
    throw new Error(NOT_YET);
  }
}

export const usSalesTax = new UsSalesTaxProvider();
