'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { CostLineRow } from '@/lib/db/queries/cost-lines';
import type { MaterialsCatalogRow } from '@/lib/db/queries/materials-catalog';
import { formatCurrency } from '@/lib/pricing/calculator';
import { upsertCostLineAction } from '@/server/actions/project-cost-control';
import { CostLinePhotoStrip } from './cost-line-photo-strip';
import { LastUsedPriceHints } from './last-used-price-hints';

const CATEGORIES = ['material', 'labour', 'sub', 'equipment', 'overhead'] as const;

function centsToDisplay(cents: number) {
  return (cents / 100).toFixed(2);
}
function displayToCents(val: string) {
  return Math.round(parseFloat(val || '0') * 100);
}

export function CostLineForm({
  projectId,
  initial,
  catalog,
  defaultBucketId,
  onDone,
  photoUrls,
}: {
  projectId: string;
  initial?: CostLineRow;
  catalog: MaterialsCatalogRow[];
  defaultBucketId?: string;
  onDone: () => void;
  /** Path → signed URL map for any existing photos on this line. */
  photoUrls?: Record<string, string>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');

  const [category, setCategory] = useState<string>(initial?.category ?? 'material');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [qty, setQty] = useState(initial ? String(initial.qty) : '1');
  const [unit, setUnit] = useState(initial?.unit ?? 'item');
  const [costRaw, setCostRaw] = useState(initial ? centsToDisplay(initial.unit_cost_cents) : '');
  const [priceRaw, setPriceRaw] = useState(initial ? centsToDisplay(initial.unit_price_cents) : '');
  const [markupRaw, setMarkupRaw] = useState(
    initial ? (Number(initial.markup_pct) || 0).toFixed(2) : '',
  );
  const [notes, setNotes] = useState(initial?.notes ?? '');

  function computeMarkupFromPrice(cost: string, price: string): string {
    const c = parseFloat(cost || '0');
    const p = parseFloat(price || '0');
    if (c <= 0) return '';
    return (((p - c) / c) * 100).toFixed(2);
  }

  function computePriceFromMarkup(cost: string, markup: string): string {
    const c = parseFloat(cost || '0');
    const m = parseFloat(markup || '0');
    if (c <= 0) return '';
    return (c * (1 + m / 100)).toFixed(2);
  }

  function applyFromCatalog(item: MaterialsCatalogRow) {
    setCategory(item.category);
    setLabel(item.label);
    setUnit(item.unit);
    const cost = centsToDisplay(item.unit_cost_cents);
    const price = centsToDisplay(item.unit_price_cents);
    setCostRaw(cost);
    setPriceRaw(price);
    setMarkupRaw(computeMarkupFromPrice(cost, price));
  }

  function handleCostChange(val: string) {
    setCostRaw(val);
    if (markupRaw && parseFloat(val || '0') > 0) {
      setPriceRaw(computePriceFromMarkup(val, markupRaw));
    }
  }

  function handleCostBlur() {
    const cost = parseFloat(costRaw || '0');
    const price = parseFloat(priceRaw || '0');
    if (cost > 0 && price === 0 && !markupRaw) {
      setPriceRaw(costRaw);
      setMarkupRaw('0.00');
    }
  }

  function handlePriceChange(val: string) {
    setPriceRaw(val);
    setMarkupRaw(computeMarkupFromPrice(costRaw, val));
  }

  function handleMarkupChange(val: string) {
    setMarkupRaw(val);
    if (parseFloat(costRaw || '0') > 0) {
      setPriceRaw(computePriceFromMarkup(costRaw, val));
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const unit_cost_cents = displayToCents(costRaw);
    const unit_price_cents = displayToCents(priceRaw);
    const markup_pct =
      unit_cost_cents > 0
        ? Math.round(((unit_price_cents - unit_cost_cents) / unit_cost_cents) * 100 * 100) / 100
        : 0;

    startTransition(async () => {
      const res = await upsertCostLineAction({
        id: initial?.id,
        project_id: projectId,
        budget_category_id: initial?.budget_category_id ?? defaultBucketId,
        category,
        label,
        qty: parseFloat(qty || '1'),
        unit,
        unit_cost_cents,
        unit_price_cents,
        markup_pct,
        notes,
      });
      if (res.ok) onDone();
      else setError(res.error);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border bg-muted/30 p-4">
      {catalog.length > 0 && (
        <div>
          <label htmlFor="cl-catalog" className="mb-1 block text-xs font-medium">
            From catalog (optional)
          </label>
          <select
            id="cl-catalog"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            defaultValue=""
            onChange={(e) => {
              const item = catalog.find((c) => c.id === e.target.value);
              if (item) applyFromCatalog(item);
            }}
          >
            <option value="">— pick from catalog —</option>
            {catalog.map((c) => (
              <option key={c.id} value={c.id}>
                [{c.category}] {c.label} — {formatCurrency(c.unit_price_cents)}/{c.unit}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <label htmlFor="cl-label" className="mb-1 block text-xs font-medium">
            Label
          </label>
          <Input
            id="cl-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Description"
            required
          />
        </div>
        <div>
          <label htmlFor="cl-cat" className="mb-1 block text-xs font-medium">
            Category
          </label>
          <select
            id="cl-cat"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="cl-unit" className="mb-1 block text-xs font-medium">
            Unit
          </label>
          <Input
            id="cl-unit"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder="item"
          />
        </div>
        <div>
          <label htmlFor="cl-qty" className="mb-1 block text-xs font-medium">
            Qty
          </label>
          <Input
            id="cl-qty"
            type="number"
            step="0.01"
            min="0.01"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="cl-cost" className="mb-1 block text-xs font-medium">
            Cost / unit ($)
          </label>
          <Input
            id="cl-cost"
            type="number"
            step="0.01"
            min="0"
            value={costRaw}
            onChange={(e) => handleCostChange(e.target.value)}
            onBlur={handleCostBlur}
            placeholder="0.00"
          />
        </div>
        <div>
          <label htmlFor="cl-markup" className="mb-1 block text-xs font-medium">
            Markup (%)
          </label>
          <Input
            id="cl-markup"
            type="number"
            step="0.01"
            value={markupRaw}
            onChange={(e) => handleMarkupChange(e.target.value)}
            placeholder="0"
          />
        </div>
        <div>
          <label htmlFor="cl-price" className="mb-1 block text-xs font-medium">
            Price / unit ($)
          </label>
          <Input
            id="cl-price"
            type="number"
            step="0.01"
            min="0"
            value={priceRaw}
            onChange={(e) => handlePriceChange(e.target.value)}
            placeholder="0.00"
          />
          <LastUsedPriceHints
            label={label}
            category={category}
            excludeProjectId={projectId}
            onPick={(p) => handlePriceChange(p)}
          />
        </div>
      </div>
      <div>
        <label htmlFor="cl-notes" className="mb-1 block text-xs font-medium">
          Description
        </label>
        <Textarea
          id="cl-notes"
          rows={5}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Add details, photos this references, material notes, etc."
        />
      </div>
      {initial ? (
        <div>
          <p className="mb-1 text-xs font-medium">Photos</p>
          <CostLinePhotoStrip
            costLineId={initial.id}
            projectId={projectId}
            photos={(initial.photo_storage_paths ?? [])
              .map((path) => ({ path, url: photoUrls?.[path] ?? '' }))
              .filter((p) => p.url)}
          />
        </div>
      ) : null}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : initial ? 'Update' : 'Add line'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
