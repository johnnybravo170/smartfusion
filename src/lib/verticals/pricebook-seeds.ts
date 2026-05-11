/**
 * Vertical-aware pricebook starter packs.
 *
 * When a new tenant signs up (or an existing tenant clicks "Add starter
 * pack" in /settings/pricebook), we seed `catalog_items` with a sensible
 * set of defaults for their vertical. They edit from there.
 *
 * Numbers are reasonable BC-market starting points based on common
 * pricing patterns for each trade — meant as a starting framework, not
 * a recommendation. Tenants should adjust.
 *
 * Idempotency: callers should match on (tenant_id, lower(name)) to avoid
 * re-inserting seeds if the user invokes "add starter pack" twice.
 */

import type { CatalogCategory, CatalogPricingModel } from '@/lib/db/schema/catalog-items';

export type PricebookSeed = {
  name: string;
  description?: string;
  pricingModel: CatalogPricingModel;
  unitLabel?: string;
  unitPriceCents?: number;
  minChargeCents?: number;
  isTaxable?: boolean;
  category?: CatalogCategory;
  surfaceType?: string;
};

const PRESSURE_WASHING_SEEDS: PricebookSeed[] = [
  {
    name: 'Concrete driveway',
    pricingModel: 'per_unit',
    unitLabel: 'sqft',
    unitPriceCents: 25,
    minChargeCents: 25000,
    category: 'service',
    surfaceType: 'concrete',
  },
  {
    name: 'House siding',
    pricingModel: 'per_unit',
    unitLabel: 'sqft',
    unitPriceCents: 35,
    minChargeCents: 35000,
    category: 'service',
    surfaceType: 'siding',
  },
  {
    name: 'Wood deck',
    pricingModel: 'per_unit',
    unitLabel: 'sqft',
    unitPriceCents: 75,
    minChargeCents: 30000,
    category: 'service',
    surfaceType: 'deck',
  },
  {
    name: 'Roof soft wash',
    pricingModel: 'per_unit',
    unitLabel: 'sqft',
    unitPriceCents: 45,
    minChargeCents: 40000,
    category: 'service',
    surfaceType: 'roof',
  },
];

const HVAC_SEEDS: PricebookSeed[] = [
  {
    name: 'Diagnostic / service call',
    pricingModel: 'fixed',
    unitPriceCents: 14900,
    category: 'service',
  },
  { name: 'Furnace tune-up', pricingModel: 'fixed', unitPriceCents: 8900, category: 'service' },
  { name: 'AC tune-up', pricingModel: 'fixed', unitPriceCents: 8900, category: 'service' },
  {
    name: 'Refrigerant recharge (1 lb)',
    pricingModel: 'per_unit',
    unitLabel: 'lb',
    unitPriceCents: 18900,
    category: 'materials',
  },
  {
    name: 'Furnace install (mid-efficiency)',
    pricingModel: 'time_and_materials',
    category: 'service',
  },
  { name: 'AC install (3-ton)', pricingModel: 'time_and_materials', category: 'service' },
  {
    name: 'Labor — installer',
    pricingModel: 'hourly',
    unitLabel: 'hr',
    unitPriceCents: 14500,
    category: 'labor',
  },
];

const PLUMBING_SEEDS: PricebookSeed[] = [
  {
    name: 'Service call / diagnostic',
    pricingModel: 'fixed',
    unitPriceCents: 12500,
    category: 'service',
  },
  {
    name: 'Drain cleaning (single fixture)',
    pricingModel: 'fixed',
    unitPriceCents: 18900,
    category: 'service',
  },
  {
    name: 'Drain camera inspection',
    pricingModel: 'fixed',
    unitPriceCents: 24900,
    category: 'service',
  },
  {
    name: 'Water heater install (40-gal gas)',
    pricingModel: 'fixed',
    unitPriceCents: 195000,
    category: 'service',
  },
  { name: 'Toilet install', pricingModel: 'fixed', unitPriceCents: 35000, category: 'service' },
  { name: 'Faucet replacement', pricingModel: 'fixed', unitPriceCents: 22500, category: 'service' },
  {
    name: 'Labor — journeyman plumber',
    pricingModel: 'hourly',
    unitLabel: 'hr',
    unitPriceCents: 13500,
    category: 'labor',
  },
];

const ELECTRICAL_SEEDS: PricebookSeed[] = [
  {
    name: 'Service call / diagnostic',
    pricingModel: 'fixed',
    unitPriceCents: 14500,
    category: 'service',
  },
  {
    name: 'Outlet install (standard)',
    pricingModel: 'fixed',
    unitPriceCents: 15500,
    category: 'service',
  },
  {
    name: 'GFCI outlet install',
    pricingModel: 'fixed',
    unitPriceCents: 22500,
    category: 'service',
  },
  {
    name: 'Light fixture replacement',
    pricingModel: 'fixed',
    unitPriceCents: 18900,
    category: 'service',
  },
  {
    name: 'EV charger install (Level 2)',
    pricingModel: 'fixed',
    unitPriceCents: 145000,
    category: 'service',
  },
  { name: 'Panel upgrade (200A)', pricingModel: 'time_and_materials', category: 'service' },
  {
    name: 'Labor — journeyman electrician',
    pricingModel: 'hourly',
    unitLabel: 'hr',
    unitPriceCents: 14500,
    category: 'labor',
  },
];

const GC_SEEDS: PricebookSeed[] = [
  { name: 'Demo (kitchen)', pricingModel: 'time_and_materials', category: 'labor' },
  { name: 'Framing', pricingModel: 'time_and_materials', category: 'labor' },
  { name: 'Drywall (hang, tape, mud)', pricingModel: 'time_and_materials', category: 'labor' },
  {
    name: 'Interior paint (per room)',
    pricingModel: 'fixed',
    unitPriceCents: 65000,
    category: 'service',
  },
  {
    name: 'Tile install',
    pricingModel: 'per_unit',
    unitLabel: 'sqft',
    unitPriceCents: 1500,
    category: 'service',
  },
  {
    name: 'Labor — carpenter',
    pricingModel: 'hourly',
    unitLabel: 'hr',
    unitPriceCents: 9500,
    category: 'labor',
  },
  {
    name: 'Labor — laborer',
    pricingModel: 'hourly',
    unitLabel: 'hr',
    unitPriceCents: 5500,
    category: 'labor',
  },
];

const ROOFING_SEEDS: PricebookSeed[] = [
  {
    name: 'Tear-off (asphalt)',
    pricingModel: 'per_unit',
    unitLabel: 'sq',
    unitPriceCents: 9500,
    category: 'service',
  },
  {
    name: 'Asphalt shingle install',
    pricingModel: 'per_unit',
    unitLabel: 'sq',
    unitPriceCents: 42500,
    category: 'service',
  },
  {
    name: 'Metal roof install',
    pricingModel: 'per_unit',
    unitLabel: 'sq',
    unitPriceCents: 90000,
    category: 'service',
  },
  {
    name: 'Flat roof (TPO)',
    pricingModel: 'per_unit',
    unitLabel: 'sqft',
    unitPriceCents: 1100,
    category: 'service',
  },
  {
    name: 'Service call / inspection',
    pricingModel: 'fixed',
    unitPriceCents: 19500,
    category: 'service',
  },
  {
    name: 'Labor — roofer',
    pricingModel: 'hourly',
    unitLabel: 'hr',
    unitPriceCents: 8500,
    category: 'labor',
  },
];

const LANDSCAPING_SEEDS: PricebookSeed[] = [
  {
    name: 'Lawn mow (residential, weekly)',
    pricingModel: 'fixed',
    unitPriceCents: 6500,
    category: 'service',
  },
  { name: 'Spring cleanup', pricingModel: 'fixed', unitPriceCents: 25000, category: 'service' },
  { name: 'Fall cleanup', pricingModel: 'fixed', unitPriceCents: 25000, category: 'service' },
  {
    name: 'Mulch install',
    pricingModel: 'per_unit',
    unitLabel: 'yd',
    unitPriceCents: 9500,
    category: 'materials',
  },
  {
    name: 'Hedge trimming',
    pricingModel: 'hourly',
    unitLabel: 'hr',
    unitPriceCents: 7500,
    category: 'service',
  },
  {
    name: 'Sod install',
    pricingModel: 'per_unit',
    unitLabel: 'sqft',
    unitPriceCents: 250,
    category: 'service',
  },
  {
    name: 'Labor — landscaper',
    pricingModel: 'hourly',
    unitLabel: 'hr',
    unitPriceCents: 6500,
    category: 'labor',
  },
];

/**
 * Map of vertical id → starter seeds. Returns null for any vertical we
 * don't have an opinion on (caller seeds nothing in that case).
 */
const SEEDS_BY_VERTICAL: Record<string, PricebookSeed[]> = {
  pressure_washing: PRESSURE_WASHING_SEEDS,
  hvac: HVAC_SEEDS,
  plumbing: PLUMBING_SEEDS,
  electrical: ELECTRICAL_SEEDS,
  gc: GC_SEEDS,
  renovation: GC_SEEDS,
  general_contractor: GC_SEEDS,
  roofing: ROOFING_SEEDS,
  landscaping: LANDSCAPING_SEEDS,
};

export function getPricebookSeeds(vertical: string | null | undefined): PricebookSeed[] {
  if (!vertical) return [];
  return SEEDS_BY_VERTICAL[vertical] ?? [];
}

export const SUPPORTED_VERTICALS_WITH_SEEDS = Object.keys(SEEDS_BY_VERTICAL);
