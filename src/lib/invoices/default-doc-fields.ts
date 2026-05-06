/**
 * Suggested default text shown in the Settings → Invoicing form and used
 * by the inline setup dialog on the operator invoice detail page. The
 * operator clicks "Use suggested text" to paste these into the field;
 * nothing is silently saved.
 *
 * If you change a placeholder here, also evaluate the dialog copy on the
 * invoice detail page so the two surfaces stay in sync.
 */

export const SUGGESTED_INVOICE_DEFAULTS = {
  payment_instructions:
    'E-transfer to billing@your-business.ca (auto-deposit, no password needed).\n\nOr cheque payable to Your Business Ltd, mailed to:\n123 Main Street, Vancouver BC V0V 0V0',
  terms:
    'Payment is due within 30 days of the invoice date. Draws are due within 7 days of receipt.',
  policies:
    'Late payments are subject to 2% interest per month after 30 days. Returned cheques: $50 fee.',
} as const;

export type InvoiceDocFields = {
  payment_instructions: string | null;
  terms: string | null;
  policies: string | null;
};

/**
 * Returns the count of fields that are missing on a tenant. Used to drive
 * the inline setup banner on the operator invoice detail page.
 */
export function countMissingDocFields(fields: InvoiceDocFields): number {
  return [fields.payment_instructions, fields.terms, fields.policies].filter(
    (v) => v == null || v.trim().length === 0,
  ).length;
}

/**
 * Resolve effective doc fields for a single invoice render. Override columns
 * on the invoice row (set via the operator detail page) win over the tenant
 * defaults; null/empty falls through. The render surfaces (email + public
 * view) only need the resolved values — the source distinction is just for
 * the override-active indicator on the operator page.
 */
export function resolveInvoiceDocFields(args: {
  override: Partial<InvoiceDocFields>;
  tenant: InvoiceDocFields;
}): InvoiceDocFields {
  const pick = (o: string | null | undefined, t: string | null) => {
    const trimmed = o?.trim();
    if (trimmed && trimmed.length > 0) return trimmed;
    return t;
  };
  return {
    payment_instructions: pick(
      args.override.payment_instructions,
      args.tenant.payment_instructions,
    ),
    terms: pick(args.override.terms, args.tenant.terms),
    policies: pick(args.override.policies, args.tenant.policies),
  };
}

export function hasAnyOverride(override: Partial<InvoiceDocFields>): boolean {
  return [override.payment_instructions, override.terms, override.policies].some(
    (v) => v != null && v.trim().length > 0,
  );
}
