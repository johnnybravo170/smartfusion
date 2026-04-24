'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { LabourRateRow } from '@/lib/db/queries/labour-rates';
import type { MaterialsCatalogRow } from '@/lib/db/queries/materials-catalog';
import { formatCurrency } from '@/lib/pricing/calculator';
import {
  deleteLabourRateAction,
  deleteMaterialAction,
  upsertLabourRateAction,
  upsertMaterialAction,
} from '@/server/actions/cost-catalog';

const CATEGORIES = ['material', 'labour', 'sub', 'equipment', 'overhead'] as const;
const UNITS = ['item', 'sqft', 'lf', 'hr', 'ea', 'lot', 'bag', 'sheet', 'lb'];

function centsToDisplay(cents: number) {
  return (cents / 100).toFixed(2);
}
function displayToCents(val: string) {
  return Math.round(parseFloat(val || '0') * 100);
}

// ─── Material form ────────────────────────────────────────────────────────────

function MaterialForm({ initial, onDone }: { initial?: MaterialsCatalogRow; onDone: () => void }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');

  const [category, setCategory] = useState<string>(initial?.category ?? 'material');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [unit, setUnit] = useState(initial?.unit ?? 'item');
  const [costRaw, setCostRaw] = useState(initial ? centsToDisplay(initial.unit_cost_cents) : '');
  const [priceRaw, setPriceRaw] = useState(initial ? centsToDisplay(initial.unit_price_cents) : '');
  const [vendor, setVendor] = useState(initial?.vendor ?? '');
  const [costCode, setCostCode] = useState(initial?.cost_code ?? '');

  function handlePriceBlur() {
    const cost = parseFloat(costRaw || '0');
    const price = parseFloat(priceRaw || '0');
    if (cost > 0 && price === 0) {
      setPriceRaw(costRaw);
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
      const res = await upsertMaterialAction({
        id: initial?.id,
        category,
        label,
        unit,
        unit_cost_cents,
        unit_price_cents,
        markup_pct,
        vendor,
        cost_code: costCode,
      });
      if (res.ok) {
        onDone();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <label htmlFor="ccm-label" className="mb-1 block text-xs font-medium">
            Label
          </label>
          <Input
            id="ccm-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Framing lumber 2×4"
            required
          />
        </div>
        <div>
          <label htmlFor="ccm-category" className="mb-1 block text-xs font-medium">
            Category
          </label>
          <select
            id="ccm-category"
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
          <label htmlFor="ccm-unit" className="mb-1 block text-xs font-medium">
            Unit
          </label>
          <select
            id="ccm-unit"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          >
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ccm-cost" className="mb-1 block text-xs font-medium">
            Cost / unit ($)
          </label>
          <Input
            id="ccm-cost"
            type="number"
            step="0.01"
            min="0"
            value={costRaw}
            onChange={(e) => setCostRaw(e.target.value)}
            onBlur={handlePriceBlur}
            placeholder="0.00"
          />
        </div>
        <div>
          <label htmlFor="ccm-price" className="mb-1 block text-xs font-medium">
            Price / unit ($)
          </label>
          <Input
            id="ccm-price"
            type="number"
            step="0.01"
            min="0"
            value={priceRaw}
            onChange={(e) => setPriceRaw(e.target.value)}
            placeholder="0.00"
          />
        </div>
        <div>
          <label htmlFor="ccm-vendor" className="mb-1 block text-xs font-medium">
            Vendor
          </label>
          <Input
            id="ccm-vendor"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            placeholder="Optional"
          />
        </div>
        <div>
          <label htmlFor="ccm-cost-code" className="mb-1 block text-xs font-medium">
            Cost code
          </label>
          <Input
            id="ccm-cost-code"
            value={costCode}
            onChange={(e) => setCostCode(e.target.value)}
            placeholder="Optional"
          />
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : initial ? 'Update' : 'Add item'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ─── Labour rate form ─────────────────────────────────────────────────────────

function LabourRateForm({ initial, onDone }: { initial?: LabourRateRow; onDone: () => void }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [trade, setTrade] = useState(initial?.trade ?? '');
  const [role, setRole] = useState(initial?.role ?? 'lead');
  const [costRaw, setCostRaw] = useState(
    initial ? centsToDisplay(initial.cost_per_hour_cents) : '',
  );
  const [billRaw, setBillRaw] = useState(
    initial ? centsToDisplay(initial.bill_per_hour_cents) : '',
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    startTransition(async () => {
      const res = await upsertLabourRateAction({
        id: initial?.id,
        trade,
        role,
        cost_per_hour_cents: displayToCents(costRaw),
        bill_per_hour_cents: displayToCents(billRaw),
      });
      if (res.ok) onDone();
      else setError(res.error);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <label htmlFor="lr-trade" className="mb-1 block text-xs font-medium">
            Trade
          </label>
          <Input
            id="lr-trade"
            value={trade}
            onChange={(e) => setTrade(e.target.value)}
            placeholder="e.g. Carpenter"
            required
          />
        </div>
        <div>
          <label htmlFor="lr-role" className="mb-1 block text-xs font-medium">
            Role
          </label>
          <Input
            id="lr-role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="lead"
            required
          />
        </div>
        <div>
          <label htmlFor="lr-cost" className="mb-1 block text-xs font-medium">
            Cost / hr ($)
          </label>
          <Input
            id="lr-cost"
            type="number"
            step="0.01"
            min="0"
            value={costRaw}
            onChange={(e) => setCostRaw(e.target.value)}
            placeholder="0.00"
          />
        </div>
        <div>
          <label htmlFor="lr-bill" className="mb-1 block text-xs font-medium">
            Bill / hr ($)
          </label>
          <Input
            id="lr-bill"
            type="number"
            step="0.01"
            min="0"
            value={billRaw}
            onChange={(e) => setBillRaw(e.target.value)}
            placeholder="0.00"
          />
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : initial ? 'Update' : 'Add rate'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ─── Main manager ─────────────────────────────────────────────────────────────

export function CostCatalogManager({
  materials,
  labourRates,
}: {
  materials: MaterialsCatalogRow[];
  labourRates: LabourRateRow[];
}) {
  const [activeTab, setActiveTab] = useState<'materials' | 'labour'>('materials');
  const [showMaterialForm, setShowMaterialForm] = useState(false);
  const [editingMaterial, setEditingMaterial] = useState<MaterialsCatalogRow | null>(null);
  const [showLabourForm, setShowLabourForm] = useState(false);
  const [editingLabour, setEditingLabour] = useState<LabourRateRow | null>(null);
  const [, startTransition] = useTransition();

  function deleteMaterial(id: string) {
    if (!confirm('Delete this item?')) return;
    startTransition(async () => {
      await deleteMaterialAction(id);
    });
  }

  function deleteLabour(id: string) {
    if (!confirm('Delete this rate?')) return;
    startTransition(async () => {
      await deleteLabourRateAction(id);
    });
  }

  return (
    <div className="space-y-4">
      {/* Tab switcher */}
      <div className="flex gap-1 border-b">
        {(['materials', 'labour'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setActiveTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === t
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t === 'materials' ? 'Materials & Subs' : 'Labour Rates'}
          </button>
        ))}
      </div>

      {/* Materials tab */}
      {activeTab === 'materials' && (
        <div className="space-y-3">
          {showMaterialForm || editingMaterial ? (
            <MaterialForm
              initial={editingMaterial ?? undefined}
              onDone={() => {
                setShowMaterialForm(false);
                setEditingMaterial(null);
              }}
            />
          ) : (
            <Button size="sm" onClick={() => setShowMaterialForm(true)}>
              + Add item
            </Button>
          )}

          {materials.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No items yet. Add your first cost item above.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2 text-left font-medium">Item</th>
                    <th className="px-3 py-2 text-left font-medium">Category</th>
                    <th className="px-3 py-2 text-left font-medium">Unit</th>
                    <th className="px-3 py-2 text-right font-medium">Cost</th>
                    <th className="px-3 py-2 text-right font-medium">Price</th>
                    <th className="px-3 py-2 text-right font-medium">Markup</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {materials.map((m) => (
                    <tr
                      key={m.id}
                      className={`border-b last:border-0 ${!m.is_active ? 'opacity-50' : ''}`}
                    >
                      <td className="px-3 py-2">
                        <p className="font-medium">{m.label}</p>
                        {m.vendor && <p className="text-xs text-muted-foreground">{m.vendor}</p>}
                      </td>
                      <td className="px-3 py-2 capitalize text-muted-foreground">{m.category}</td>
                      <td className="px-3 py-2 text-muted-foreground">{m.unit}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(m.unit_cost_cents)}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(m.unit_price_cents)}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground">
                        {Number(m.markup_pct).toFixed(1)}%
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => {
                              setEditingMaterial(m);
                              setShowMaterialForm(false);
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() => deleteMaterial(m.id)}
                          >
                            Del
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Labour rates tab */}
      {activeTab === 'labour' && (
        <div className="space-y-3">
          {showLabourForm || editingLabour ? (
            <LabourRateForm
              initial={editingLabour ?? undefined}
              onDone={() => {
                setShowLabourForm(false);
                setEditingLabour(null);
              }}
            />
          ) : (
            <Button size="sm" onClick={() => setShowLabourForm(true)}>
              + Add rate
            </Button>
          )}

          {labourRates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No rates yet. Add your trade rates above.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2 text-left font-medium">Trade</th>
                    <th className="px-3 py-2 text-left font-medium">Role</th>
                    <th className="px-3 py-2 text-right font-medium">Cost / hr</th>
                    <th className="px-3 py-2 text-right font-medium">Bill / hr</th>
                    <th className="px-3 py-2 text-right font-medium">Margin</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {labourRates.map((r) => {
                    const marginPct =
                      r.bill_per_hour_cents > 0
                        ? Math.round(
                            ((r.bill_per_hour_cents - r.cost_per_hour_cents) /
                              r.bill_per_hour_cents) *
                              100,
                          )
                        : 0;
                    return (
                      <tr
                        key={r.id}
                        className={`border-b last:border-0 ${!r.is_active ? 'opacity-50' : ''}`}
                      >
                        <td className="px-3 py-2 font-medium">{r.trade}</td>
                        <td className="px-3 py-2 text-muted-foreground">{r.role}</td>
                        <td className="px-3 py-2 text-right">
                          {formatCurrency(r.cost_per_hour_cents)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {formatCurrency(r.bill_per_hour_cents)}
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{marginPct}%</td>
                        <td className="px-3 py-2">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => {
                                setEditingLabour(r);
                                setShowLabourForm(false);
                              }}
                            >
                              Edit
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              className="text-destructive hover:text-destructive"
                              onClick={() => deleteLabour(r.id)}
                            >
                              Del
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
