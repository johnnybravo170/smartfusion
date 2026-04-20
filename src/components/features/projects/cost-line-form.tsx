'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { CostLineRow } from '@/lib/db/queries/cost-lines';
import type { MaterialsCatalogRow } from '@/lib/db/queries/materials-catalog';
import { formatCurrency } from '@/lib/pricing/calculator';
import { upsertCostLineAction } from '@/server/actions/project-cost-control';

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
}: {
  projectId: string;
  initial?: CostLineRow;
  catalog: MaterialsCatalogRow[];
  defaultBucketId?: string;
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');

  const [category, setCategory] = useState<string>(initial?.category ?? 'material');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [qty, setQty] = useState(initial ? String(initial.qty) : '1');
  const [unit, setUnit] = useState(initial?.unit ?? 'item');
  const [costRaw, setCostRaw] = useState(initial ? centsToDisplay(initial.unit_cost_cents) : '');
  const [priceRaw, setPriceRaw] = useState(initial ? centsToDisplay(initial.unit_price_cents) : '');
  const [notes, setNotes] = useState(initial?.notes ?? '');

  function applyFromCatalog(item: MaterialsCatalogRow) {
    setCategory(item.category);
    setLabel(item.label);
    setUnit(item.unit);
    setCostRaw(centsToDisplay(item.unit_cost_cents));
    setPriceRaw(centsToDisplay(item.unit_price_cents));
  }

  function handleCostBlur() {
    const cost = parseFloat(costRaw || '0');
    const price = parseFloat(priceRaw || '0');
    if (cost > 0 && price === 0) setPriceRaw(costRaw);
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
        bucket_id: initial?.bucket_id ?? defaultBucketId,
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
            onChange={(e) => setCostRaw(e.target.value)}
            onBlur={handleCostBlur}
            placeholder="0.00"
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
            onChange={(e) => setPriceRaw(e.target.value)}
            placeholder="0.00"
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
