/**
 * Canadian provincial tax rates.
 *
 * Source of truth for "what tax should we charge / what's implicit in
 * this receipt" decisions. Every tax computation in the app should
 * resolve rates through here rather than reading tenant.gst_rate /
 * pst_rate directly.
 *
 * Rate accuracy as of Q2 2025. Provincial rates change rarely (last
 * major shift: NS planning a 15→14% HST reduction in April 2025). If a
 * province changes its rate, update this table and redeploy.
 *
 * Label text matches what customers expect on invoices — HST provinces
 * show one line; GST+PST provinces show two; QC has its own regime
 * (GST + QST) but is modeled as two lines for UI consistency.
 */

export type ProvinceCode =
  | 'AB'
  | 'BC'
  | 'MB'
  | 'NB'
  | 'NL'
  | 'NS'
  | 'NT'
  | 'NU'
  | 'ON'
  | 'PE'
  | 'QC'
  | 'SK'
  | 'YT';

export type ProvincialTaxRates = {
  code: ProvinceCode;
  name: string;
  /** Federal 5% GST portion OR combined HST (provinces that joined HST). */
  gstRate: number;
  /** Provincial component. 0 for HST provinces (baked into gstRate). */
  pstRate: number;
  /**
   * Display labels. Single entry for HST provinces, two for GST+PST.
   * Used by invoice/quote PDFs and on-screen totals.
   */
  breakdown: Array<{ label: string; rate: number }>;
  /** Short note explaining which bucket this province uses. */
  note: string;
};

/**
 * Full province table. Provinces with HST collapse federal + provincial
 * into a single `gstRate` line (because that's how CRA and QBO treat it).
 * GST+PST provinces keep them separate.
 *
 * PST in BC/SK/MB and QST in QC are applied on top of GST on the pre-tax
 * subtotal (i.e. not a tax-on-tax). Matches CRA guidance.
 *
 * Worth noting: some PST regimes only apply to tangible goods, not labour.
 * A renovation contractor in BC charges PST on materials but typically
 * not on labour. We don't model that here — the operator sets the right
 * rate per line if they care. Default behavior covers the common case
 * (flat rate on the whole invoice).
 */
export const PROVINCE_RATES: Record<ProvinceCode, ProvincialTaxRates> = {
  AB: {
    code: 'AB',
    name: 'Alberta',
    gstRate: 0.05,
    pstRate: 0,
    breakdown: [{ label: 'GST 5%', rate: 0.05 }],
    note: 'GST only. No provincial sales tax.',
  },
  BC: {
    code: 'BC',
    name: 'British Columbia',
    gstRate: 0.05,
    pstRate: 0.07,
    breakdown: [
      { label: 'GST 5%', rate: 0.05 },
      { label: 'PST 7%', rate: 0.07 },
    ],
    note: 'GST + PST. Note PST may not apply to labour — adjust per-line if needed.',
  },
  MB: {
    code: 'MB',
    name: 'Manitoba',
    gstRate: 0.05,
    pstRate: 0.07,
    breakdown: [
      { label: 'GST 5%', rate: 0.05 },
      { label: 'PST 7%', rate: 0.07 },
    ],
    note: 'GST + RST (Manitoba PST).',
  },
  NB: {
    code: 'NB',
    name: 'New Brunswick',
    gstRate: 0.15,
    pstRate: 0,
    breakdown: [{ label: 'HST 15%', rate: 0.15 }],
    note: 'HST province — single 15% rate.',
  },
  NL: {
    code: 'NL',
    name: 'Newfoundland and Labrador',
    gstRate: 0.15,
    pstRate: 0,
    breakdown: [{ label: 'HST 15%', rate: 0.15 }],
    note: 'HST province — single 15% rate.',
  },
  NS: {
    code: 'NS',
    name: 'Nova Scotia',
    gstRate: 0.14,
    pstRate: 0,
    breakdown: [{ label: 'HST 14%', rate: 0.14 }],
    note: 'HST province — 14% as of Apr 2025 (was 15%).',
  },
  NT: {
    code: 'NT',
    name: 'Northwest Territories',
    gstRate: 0.05,
    pstRate: 0,
    breakdown: [{ label: 'GST 5%', rate: 0.05 }],
    note: 'GST only.',
  },
  NU: {
    code: 'NU',
    name: 'Nunavut',
    gstRate: 0.05,
    pstRate: 0,
    breakdown: [{ label: 'GST 5%', rate: 0.05 }],
    note: 'GST only.',
  },
  ON: {
    code: 'ON',
    name: 'Ontario',
    gstRate: 0.13,
    pstRate: 0,
    breakdown: [{ label: 'HST 13%', rate: 0.13 }],
    note: 'HST province — single 13% rate.',
  },
  PE: {
    code: 'PE',
    name: 'Prince Edward Island',
    gstRate: 0.15,
    pstRate: 0,
    breakdown: [{ label: 'HST 15%', rate: 0.15 }],
    note: 'HST province — single 15% rate.',
  },
  QC: {
    code: 'QC',
    name: 'Quebec',
    gstRate: 0.05,
    pstRate: 0.09975,
    breakdown: [
      { label: 'GST 5%', rate: 0.05 },
      { label: 'QST 9.975%', rate: 0.09975 },
    ],
    note: 'GST + QST. QST is administered by Revenu Québec, not CRA.',
  },
  SK: {
    code: 'SK',
    name: 'Saskatchewan',
    gstRate: 0.05,
    pstRate: 0.06,
    breakdown: [
      { label: 'GST 5%', rate: 0.05 },
      { label: 'PST 6%', rate: 0.06 },
    ],
    note: 'GST + PST.',
  },
  YT: {
    code: 'YT',
    name: 'Yukon',
    gstRate: 0.05,
    pstRate: 0,
    breakdown: [{ label: 'GST 5%', rate: 0.05 }],
    note: 'GST only.',
  },
};

export function getRatesForProvince(
  province: string | null | undefined,
): ProvincialTaxRates | null {
  if (!province) return null;
  const code = province.toUpperCase() as ProvinceCode;
  return PROVINCE_RATES[code] ?? null;
}

/** Every province code with its display name, for settings dropdowns. */
export const PROVINCE_OPTIONS: Array<{ code: ProvinceCode; name: string }> = Object.values(
  PROVINCE_RATES,
).map(({ code, name }) => ({ code, name }));
