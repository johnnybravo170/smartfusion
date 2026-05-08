'use client';

/**
 * Inline price hints below the unit-price field on the cost-line form.
 *
 * Two sources, surfaced together:
 *   - Catalog (canonical): items in materials_catalog whose label
 *     fuzzy-matches the typed label. Rendered with a "Catalog" tag
 *     so the operator knows this is the established price.
 *   - Last used: trigram-similar prior cost lines from the same
 *     tenant (90 days, frequency-aggregated). Server-side query —
 *     see find_pricing_hints (migration 0182) and getPricingHintsAction.
 *
 * Both filter by the form's current `unit` so $/lot hints don't
 * pollute a $/item field. Click any chip → fills the price input.
 * Never silently auto-fills — memory as hint, not default
 * (decision 6790ef2b).
 */

import { useEffect, useMemo, useState } from 'react';
import { useTenantTimezone } from '@/lib/auth/tenant-context';
import type { MaterialsCatalogRow } from '@/lib/db/queries/materials-catalog';
import { getPricingHintsAction, type PricingHint } from '@/server/actions/pricing-hints';

type Props = {
  label: string;
  /** Current unit on the form. Used to filter both sources so we
   *  don't suggest a $/lot price for a $/item line. */
  unit?: string;
  category?: string;
  excludeProjectId?: string;
  /** Catalog rows already loaded by the form. Searched client-side
   *  since the dataset is small (typically <500 rows per tenant). */
  catalog?: MaterialsCatalogRow[];
  /** Apply the picked price (in dollars, formatted to 2dp). */
  onPick: (priceDollars: string) => void;
};

/** Lightweight fuzzy scorer for catalog labels — exact, includes,
 *  token overlap. Returns 0..1; threshold 0.4 below. */
function scoreCatalogMatch(query: string, label: string): number {
  const q = query.trim().toLowerCase();
  const l = label.trim().toLowerCase();
  if (!q || !l) return 0;
  if (q === l) return 1;
  if (l.includes(q) || q.includes(l)) return 0.85;
  const qTokens = q.split(/\s+/).filter(Boolean);
  const lTokens = l.split(/\s+/).filter(Boolean);
  if (qTokens.length === 0) return 0;
  const overlap = qTokens.filter((t) =>
    lTokens.some((lt) => lt.startsWith(t) || t.startsWith(lt) || lt.includes(t)),
  ).length;
  return (overlap / Math.max(qTokens.length, lTokens.length)) * 0.7;
}

export function LastUsedPriceHints({
  label,
  unit,
  category,
  excludeProjectId,
  catalog,
  onPick,
}: Props) {
  const tz = useTenantTimezone();
  const [hints, setHints] = useState<PricingHint[]>([]);
  const trimmed = label.trim();

  useEffect(() => {
    if (trimmed.length < 2) {
      setHints([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      getPricingHintsAction({
        label: trimmed,
        unit,
        excludeProjectId,
      }).then((rows) => {
        if (!cancelled) setHints(rows);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [trimmed, unit, excludeProjectId]);

  // Catalog matches are computed client-side from the already-loaded
  // catalog rows — no extra round-trip. Top 2 above the 0.4 threshold.
  const catalogMatches = useMemo(() => {
    if (!catalog || catalog.length === 0 || trimmed.length < 2) return [];
    const candidates = catalog
      .filter((c) => (category ? c.category === category : true))
      .filter((c) => (unit ? c.unit === unit : true))
      .map((c) => ({ row: c, score: scoreCatalogMatch(trimmed, c.label) }))
      .filter((x) => x.score >= 0.4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
    return candidates;
  }, [catalog, trimmed, category, unit]);

  if (catalogMatches.length === 0 && hints.length === 0) return null;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
      {catalogMatches.length > 0 ? (
        <>
          <span className="uppercase tracking-wide">Catalog:</span>
          {catalogMatches.map(({ row }) => (
            <button
              key={row.id}
              type="button"
              onClick={() => onPick((row.unit_price_cents / 100).toFixed(2))}
              title={`${row.label} — canonical price from your catalog`}
              className="rounded-full border border-primary/40 bg-primary/5 px-2 py-0.5 text-foreground hover:bg-primary/10"
            >
              ${(row.unit_price_cents / 100).toFixed(2)}/{row.unit}
            </button>
          ))}
        </>
      ) : null}
      {hints.length > 0 ? (
        <>
          <span className="uppercase tracking-wide">Last used:</span>
          {hints.map((h) => (
            <button
              key={`${h.unit_price_cents}-${h.unit}-${h.last_used_at}`}
              type="button"
              onClick={() => onPick((h.unit_price_cents / 100).toFixed(2))}
              title={`${h.source_label} · used ${h.use_count}× · last on ${new Intl.DateTimeFormat(
                'en-CA',
                { timeZone: tz, month: 'short', day: 'numeric' },
              ).format(new Date(h.last_used_at))}`}
              className="rounded-full border bg-background px-2 py-0.5 hover:bg-muted hover:text-foreground"
            >
              ${(h.unit_price_cents / 100).toFixed(2)}/{h.unit}
              {h.use_count > 1 ? (
                <span className="ml-1 text-muted-foreground/70">×{h.use_count}</span>
              ) : null}
            </button>
          ))}
        </>
      ) : null}
    </div>
  );
}
