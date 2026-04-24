/**
 * Provider abstraction shared types.
 *
 * Payments, tax, and payroll each have one interface. A factory in
 * `./factory.ts` selects the concrete implementation per tenant based on
 * `tenants.region`. New features MUST call providers through the factory --
 * direct SDK imports are a lint failure in CI.
 */

export type Region = 'ca-central-1';

export interface MerchantAccount {
  accountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
}

export interface OnboardingLink {
  url: string;
}

export interface CreateCheckoutSessionInput {
  tenantMerchantAccountId: string;
  currency: string;
  totalCents: number;
  applicationFeeCents: number;
  lineLabel: string;
  lineDescription?: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}

export interface CheckoutSession {
  sessionId: string;
  url: string | null;
}

export interface WebhookEvent {
  type: string;
  raw: unknown;
}

export interface PaymentProvider {
  readonly name: string;

  createMerchantAccount(metadata: Record<string, string>): Promise<{ accountId: string }>;
  createOnboardingLink(
    accountId: string,
    refreshUrl: string,
    returnUrl: string,
  ): Promise<OnboardingLink>;
  getMerchantAccount(accountId: string): Promise<MerchantAccount>;

  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSession>;

  verifyWebhook(rawBody: string, signature: string): Promise<WebhookEvent>;
}

export interface TaxComputation {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  breakdown: Array<{ label: string; rate: number; amountCents: number }>;
}

/**
 * Inverse of `computeTax`. Given a total that already includes tax
 * (the shape of a receipt or a supplier bill), split it into subtotal
 * and tax portion using the tenant's rate.
 */
export interface TaxExtraction {
  totalCents: number;
  subtotalCents: number;
  taxCents: number;
  breakdown: Array<{ label: string; rate: number; amountCents: number }>;
}

export interface TenantTaxContext {
  gstRate: number;
  pstRate: number;
  totalRate: number;
  /** Display breakdown for invoices/quotes. One entry for HST, two for GST+PST. */
  breakdown: Array<{ label: string; rate: number }>;
  /** Province code, or null if we fell back to the tenant row values. */
  provinceCode: string | null;
  /** Human label for summary ("HST 13%", "GST 5% + PST 7%"). */
  summaryLabel: string;
}

export interface TaxProvider {
  readonly name: string;
  /** Exclusive — add tax on top of a subtotal (quotes, invoices). */
  computeTax(input: { subtotalCents: number; tenantId: string }): Promise<TaxComputation>;
  /** Inclusive — split a receipt total into subtotal + tax. */
  extractTax(input: { totalCents: number; tenantId: string }): Promise<TaxExtraction>;
  /** Read the active rates + display context for a tenant. */
  getContext(tenantId: string): Promise<TenantTaxContext>;
}

export interface PayrollProvider {
  readonly name: string;
  // Interface placeholder -- no implementation yet. First impl lands with the
  // Gusto/Canadian payroll card.
}
