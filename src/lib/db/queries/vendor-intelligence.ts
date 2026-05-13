/**
 * Vendor intelligence — "second time you log a receipt from Home Depot,
 * Materials pre-fills".
 *
 * Purely read-side: aggregates existing `expenses` rows, grouped by
 * normalized vendor + category. Two surfaces consume it:
 *
 *   1. Overhead expense form — after the operator types / OCR fills
 *      the vendor field, we look up the most-common category they've
 *      assigned to that vendor and offer to pre-fill.
 *
 *   2. Receipt OCR prompt — we pass a "top vendors → category" hint
 *      section into the system prompt. The model uses it as a soft
 *      tiebreaker when the receipt is ambiguous.
 *
 * No new schema, no learning model. Just SQL. The "intelligence" is
 * that the aggregate grows more confident over time with zero
 * operator effort — every saved expense is training data.
 *
 * Grouping key is `lower(trim(vendor))` so "Home Depot", "HOME DEPOT",
 * and "  home depot " collapse. "The Home Depot" stays separate —
 * manual merge for now; we'll revisit if it's a real pain point.
 */

import { createAdminClient } from '@/lib/supabase/admin';

export type VendorSuggestion = {
  category_id: string;
  category_label: string; // "Vehicles › Truck 1" or "Materials"
  /** Share of matching rows that agreed on this category (0-1). */
  confidence: number;
  /** How many past entries contributed. Higher = more trust. */
  sample_size: number;
};

/**
 * Suggest a category for a single vendor. Returns null when:
 *   - No past entries with that vendor
 *   - Past entries exist but category_id is null on all of them
 *   - Confidence is too low to be useful (< 0.5 with fewer than 3
 *     entries, or < 0.4 with more)
 *
 * Tuned deliberately conservative: a wrong auto-suggest is more
 * annoying than no suggestion. Bar goes down as sample size grows.
 */
export async function getVendorSuggestion(
  tenantId: string,
  vendorRaw: string | null | undefined,
): Promise<VendorSuggestion | null> {
  if (!vendorRaw) return null;
  const vendor = vendorRaw.trim();
  if (!vendor) return null;

  const admin = createAdminClient();
  // Vendor → category hints come from past RECEIPTS (overhead categorization
  // signal). Vendor bills don't carry an `expense_categories` link.
  const { data, error } = await admin
    .from('project_costs')
    .select('category_id, categories:category_id (name, parent:parent_id (name))')
    .eq('tenant_id', tenantId)
    .eq('source_type', 'receipt')
    .eq('status', 'active')
    .ilike('vendor', vendor)
    .not('category_id', 'is', null);
  if (error || !data || data.length === 0) return null;

  type Bucket = { count: number; label: string };
  const byCat = new Map<string, Bucket>();
  for (const row of data) {
    const cid = row.category_id as string | null;
    if (!cid) continue;
    const catRaw = (row as Record<string, unknown>).categories as
      | { name?: string; parent?: { name?: string } | { name?: string }[] | null }
      | { name?: string; parent?: { name?: string } | { name?: string }[] | null }[]
      | null;
    const cat = Array.isArray(catRaw) ? catRaw[0] : catRaw;
    const parentRaw = cat?.parent;
    const parent = Array.isArray(parentRaw) ? parentRaw[0] : parentRaw;
    const label = parent?.name ? `${parent.name} › ${cat?.name ?? '?'}` : (cat?.name ?? '?');

    const existing = byCat.get(cid) ?? { count: 0, label };
    existing.count += 1;
    byCat.set(cid, existing);
  }

  const totalCategorized = Array.from(byCat.values()).reduce((s, b) => s + b.count, 0);
  if (totalCategorized === 0) return null;

  // Pick the highest-count category.
  let winner: { id: string; bucket: Bucket } | null = null;
  for (const [id, b] of byCat.entries()) {
    if (!winner || b.count > winner.bucket.count) winner = { id, bucket: b };
  }
  if (!winner) return null;

  const confidence = winner.bucket.count / totalCategorized;

  // Conservative threshold: require either very clear majority, or
  // larger sample with a reasonable lead.
  const passes =
    (totalCategorized >= 1 && confidence >= 0.8) ||
    (totalCategorized >= 3 && confidence >= 0.6) ||
    (totalCategorized >= 5 && confidence >= 0.4);
  if (!passes) return null;

  return {
    category_id: winner.id,
    category_label: winner.bucket.label,
    confidence,
    sample_size: totalCategorized,
  };
}

export type VendorCategoryHint = {
  vendor: string;
  category_id: string;
  category_label: string;
  hits: number;
};

/**
 * The N most-frequent vendor→category pairings for a tenant. Fed into
 * the OCR prompt so the model can tiebreak ambiguous receipts. Vendors
 * with fewer than 2 agreeing entries are excluded — noise.
 */
export async function getTopVendorHints(
  tenantId: string,
  limit = 10,
): Promise<VendorCategoryHint[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('project_costs')
    .select('vendor, category_id, categories:category_id (name, parent:parent_id (name))')
    .eq('tenant_id', tenantId)
    .eq('source_type', 'receipt')
    .eq('status', 'active')
    .not('vendor', 'is', null)
    .not('category_id', 'is', null);
  if (error || !data) return [];

  // Group by (normalized vendor, category).
  type Key = string; // `${lowerVendor}::${categoryId}`
  type Entry = { vendor: string; categoryId: string; label: string; hits: number };
  const byKey = new Map<Key, Entry>();
  for (const row of data) {
    const vendorStr = (row.vendor as string | null)?.trim();
    const cid = row.category_id as string | null;
    if (!vendorStr || !cid) continue;
    const key = `${vendorStr.toLowerCase()}::${cid}`;
    const catRaw = (row as Record<string, unknown>).categories as
      | { name?: string; parent?: { name?: string } | { name?: string }[] | null }
      | { name?: string; parent?: { name?: string } | { name?: string }[] | null }[]
      | null;
    const cat = Array.isArray(catRaw) ? catRaw[0] : catRaw;
    const parentRaw = cat?.parent;
    const parent = Array.isArray(parentRaw) ? parentRaw[0] : parentRaw;
    const label = parent?.name ? `${parent.name} › ${cat?.name ?? '?'}` : (cat?.name ?? '?');

    const existing = byKey.get(key) ?? { vendor: vendorStr, categoryId: cid, label, hits: 0 };
    existing.hits += 1;
    byKey.set(key, existing);
  }

  // For each vendor, pick the winning category.
  const byVendor = new Map<string, Entry>();
  for (const entry of byKey.values()) {
    const vkey = entry.vendor.toLowerCase();
    const current = byVendor.get(vkey);
    if (!current || entry.hits > current.hits) byVendor.set(vkey, entry);
  }

  return Array.from(byVendor.values())
    .filter((e) => e.hits >= 2)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map((e) => ({
      vendor: e.vendor,
      category_id: e.categoryId,
      category_label: e.label,
      hits: e.hits,
    }));
}
