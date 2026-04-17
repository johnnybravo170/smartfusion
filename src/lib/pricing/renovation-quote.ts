/**
 * Pure pricing functions for renovation quotes.
 *
 * Zero framework imports. Deterministic, all monetary values in cents.
 * 100% unit tested.
 */

export type BucketEstimate = {
  estimate_cents: number;
};

/**
 * Sum all bucket estimates into a subtotal.
 */
export function calculateBucketTotal(buckets: BucketEstimate[]): number {
  return buckets.reduce((sum, b) => sum + b.estimate_cents, 0);
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
 * Calculate the full renovation quote total: buckets + management fee + GST.
 *
 * @param buckets   - Array of bucket estimates.
 * @param feeRate   - Management fee as a decimal (e.g. 0.12 for 12%).
 * @param gstRate   - GST rate as a decimal (e.g. 0.05 for 5%).
 */
export function calculateRenovationTotal(
  buckets: BucketEstimate[],
  feeRate: number,
  gstRate: number,
): RenovationTotal {
  const subtotal_cents = calculateBucketTotal(buckets);
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
