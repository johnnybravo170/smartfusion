/**
 * Pure pricing functions for renovation quotes.
 *
 * Zero framework imports. Deterministic, all monetary values in cents.
 * 100% unit tested.
 */

export type BudgetCategoryEstimate = {
  estimate_cents: number;
};

/**
 * Sum all category estimates into a subtotal.
 */
export function calculateBudgetCategoryTotal(categories: BudgetCategoryEstimate[]): number {
  return categories.reduce((sum, b) => sum + b.estimate_cents, 0);
}

/**
 * Calculate the management fee from a subtotal and rate.
 * Rate is a decimal (e.g. 0.12 for 12%).
 */
export function calculateManagementFee(subtotal: number, rate: number): number {
  return Math.round(subtotal * rate);
}

export type RenovationTotal = {
  subtotal_cents: number;
  fee_cents: number;
  gst_cents: number;
  total_cents: number;
};

/**
 * Calculate the full renovation quote total: categories + management fee + GST.
 *
 * @param categories - Array of category estimates.
 * @param feeRate   - Management fee as a decimal (e.g. 0.12 for 12%).
 * @param gstRate   - GST rate as a decimal (e.g. 0.05 for 5%).
 */
export function calculateRenovationTotal(
  categories: BudgetCategoryEstimate[],
  feeRate: number,
  gstRate: number,
): RenovationTotal {
  const subtotal_cents = calculateBudgetCategoryTotal(categories);
  const fee_cents = calculateManagementFee(subtotal_cents, feeRate);
  const beforeTax = subtotal_cents + fee_cents;
  const gst_cents = Math.round(beforeTax * gstRate);
  return {
    subtotal_cents,
    fee_cents,
    gst_cents,
    total_cents: beforeTax + gst_cents,
  };
}
