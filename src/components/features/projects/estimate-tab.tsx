'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { upsertCostLineAction, deleteCostLineAction } from '@/server/actions/project-cost-control';
import type { CostLineRow } from '@/lib/db/queries/cost-lines';
import type { MaterialsCatalogRow } from '@/lib/db/queries/materials-catalog';
import { formatCurrency } from '@/lib/pricing/calculator';

const CATEGORIES = ['material', 'labour', 'sub', 'equipment', 'overhead'] as const;

function centsToDisplay(cents: number) {
  return (cents / 100).toFixed(2);
}
function displayToCents(val: string) {
  return Math.round(parseFloat(val || '0') * 100);
}

function CostLineForm({
  projectId,
  initial,
  catalog,
  onDone,
}: {
  projectId: string;
  initial?: CostLineRow;
  catalog: MaterialsCatalogRow[];
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
          <label className="mb-1 block text-xs font-medium">From catalog (optional)</label>
          <select
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
          <label className="mb-1 block text-xs font-medium">Label</label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Description" required />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Unit</label>
          <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="item" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Qty</label>
          <Input type="number" step="0.01" min="0.01" value={qty} onChange={(e) => setQty(e.target.value)} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Cost / unit ($)</label>
          <Input
            type="number" step="0.01" min="0"
            value={costRaw}
            onChange={(e) => setCostRaw(e.target.value)}
            onBlur={handleCostBlur}
            placeholder="0.00"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Price / unit ($)</label>
          <Input
            type="number" step="0.01" min="0"
            value={priceRaw}
            onChange={(e) => setPriceRaw(e.target.value)}
            placeholder="0.00"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Notes</label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : initial ? 'Update' : 'Add line'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

export function EstimateTab({
  projectId,
  costLines,
  catalog,
}: {
  projectId: string;
  costLines: CostLineRow[];
  catalog: MaterialsCatalogRow[];
}) {
  const [showForm, setShowForm] = useState(false);
  const [editingLine, setEditingLine] = useState<CostLineRow | null>(null);
  const [, startTransition] = useTransition();

  function deleteLine(id: string) {
    if (!confirm('Delete this line?')) return;
    startTransition(async () => { await deleteCostLineAction(id, projectId); });
  }

  const totalCost = costLines.reduce((s, l) => s + l.line_cost_cents, 0);
  const totalPrice = costLines.reduce((s, l) => s + l.line_price_cents, 0);

  const grouped = costLines.reduce<Record<string, CostLineRow[]>>((acc, line) => {
    (acc[line.category] ??= []).push(line);
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      {(showForm || editingLine) ? (
        <CostLineForm
          projectId={projectId}
          initial={editingLine ?? undefined}
          catalog={catalog}
          onDone={() => { setShowForm(false); setEditingLine(null); }}
        />
      ) : (
        <Button size="sm" onClick={() => setShowForm(true)}>+ Add line</Button>
      )}

      {costLines.length === 0 ? (
        <p className="text-sm text-muted-foreground">No cost lines yet. Add your first item above.</p>
      ) : (
        <div className="space-y-4">
          {Object.entries(grouped).map(([cat, lines]) => (
            <div key={cat}>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground capitalize">{cat}</h4>
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-3 py-2 text-left font-medium">Item</th>
                      <th className="px-3 py-2 text-right font-medium">Qty</th>
                      <th className="px-3 py-2 text-left font-medium">Unit</th>
                      <th className="px-3 py-2 text-right font-medium">Cost</th>
                      <th className="px-3 py-2 text-right font-medium">Price</th>
                      <th className="px-3 py-2 text-right font-medium">Line Price</th>
                      <th className="px-3 py-2 text-right font-medium">Markup</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => (
                      <tr key={line.id} className="border-b last:border-0">
                        <td className="px-3 py-2">
                          <p className="font-medium">{line.label}</p>
                          {line.notes && <p className="text-xs text-muted-foreground">{line.notes}</p>}
                        </td>
                        <td className="px-3 py-2 text-right">{Number(line.qty)}</td>
                        <td className="px-3 py-2 text-muted-foreground">{line.unit}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{formatCurrency(line.unit_cost_cents)}</td>
                        <td className="px-3 py-2 text-right">{formatCurrency(line.unit_price_cents)}</td>
                        <td className="px-3 py-2 text-right font-medium">{formatCurrency(line.line_price_cents)}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{Number(line.markup_pct).toFixed(1)}%</td>
                        <td className="px-3 py-2">
                          <div className="flex justify-end gap-1">
                            <Button size="xs" variant="ghost" onClick={() => { setEditingLine(line); setShowForm(false); }}>Edit</Button>
                            <Button size="xs" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => deleteLine(line.id)}>Del</Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <div className="flex justify-end gap-8 rounded-lg border bg-muted/30 px-4 py-3 text-sm">
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Total Cost</p>
              <p className="font-medium">{formatCurrency(totalCost)}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Total Price</p>
              <p className="font-semibold text-primary">{formatCurrency(totalPrice)}</p>
            </div>
            {totalCost > 0 && (
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Gross Margin</p>
                <p className="font-medium">
                  {Math.round(((totalPrice - totalCost) / totalPrice) * 100)}%
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
