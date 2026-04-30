'use client';

/**
 * Inline price hints below the unit-price field on the cost-line form.
 * Shows up to 3 distinct prices the operator has used on similar items
 * in the last 90 days. Click any chip → fills the price input. Never
 * silently auto-fills (decision 6790ef2b — memory as hint, not default).
 *
 * Matches by exact label first (case-insensitive); falls back to
 * category if there's not enough exact-label history. Hidden when the
 * label is too short to query or when no matches are returned.
 */

import { useEffect, useState } from 'react';
import { getPricingHintsAction, type PricingHint } from '@/server/actions/pricing-hints';

type Props = {
  label: string;
  category?: string;
  excludeProjectId?: string;
  /** Apply the picked price (in dollars, formatted to 2dp). */
  onPick: (priceDollars: string) => void;
};

export function LastUsedPriceHints({ label, category, excludeProjectId, onPick }: Props) {
  const [hints, setHints] = useState<PricingHint[]>([]);
  const trimmed = label.trim();

  useEffect(() => {
    if (trimmed.length < 2) {
      setHints([]);
      return;
    }
    let cancelled = false;
    // Debounce so rapid typing doesn't fire a query per keystroke.
    const t = setTimeout(() => {
      getPricingHintsAction({
        label: trimmed,
        category,
        excludeProjectId,
      }).then((rows) => {
        if (!cancelled) setHints(rows);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [trimmed, category, excludeProjectId]);

  if (hints.length === 0) return null;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
      <span className="uppercase tracking-wide">Last used:</span>
      {hints.map((h) => (
        <button
          key={`${h.unit_price_cents}-${h.unit}-${h.last_used_at}`}
          type="button"
          onClick={() => onPick((h.unit_price_cents / 100).toFixed(2))}
          title={`${h.source_label} · ${new Date(h.last_used_at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}`}
          className="rounded-full border bg-background px-2 py-0.5 hover:bg-muted hover:text-foreground"
        >
          ${(h.unit_price_cents / 100).toFixed(2)}/{h.unit}
        </button>
      ))}
    </div>
  );
}
