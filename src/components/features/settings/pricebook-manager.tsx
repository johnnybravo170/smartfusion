'use client';

/**
 * Pricebook manager — CRUD UI for `catalog_items`.
 *
 * Supports all four pricing models (fixed / per_unit / hourly /
 * time_and_materials). The legacy sqft-only catalog manager at
 * /settings/catalog continues to coexist for pressure-washing tenants
 * until the quote builder cuts over to catalog_items in PR #3.
 */

import { Loader2, Pencil, Plus, Save, Sparkles, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { CatalogItemRow } from '@/lib/db/queries/catalog-items';
import { formatCurrency } from '@/lib/pricing/calculator';
import {
  activateCatalogItemAction,
  deactivateCatalogItemAction,
  seedPricebookFromVerticalAction,
  type UpsertCatalogItemInput,
  upsertCatalogItemAction,
} from '@/server/actions/catalog-items';

const PRICING_MODELS = [
  { value: 'fixed', label: 'Flat rate' },
  { value: 'per_unit', label: 'Per unit' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'time_and_materials', label: 'Time & materials' },
] as const;

const CATEGORIES = [
  { value: 'service', label: 'Service' },
  { value: 'labor', label: 'Labor' },
  { value: 'materials', label: 'Materials' },
  { value: 'inventory', label: 'Inventory' },
  { value: 'other', label: 'Other' },
] as const;

type EditState = {
  id?: string;
  name: string;
  description: string;
  pricingModel: 'fixed' | 'per_unit' | 'hourly' | 'time_and_materials';
  unitLabel: string;
  /** Dollars as string for input control. Converted to cents on save. */
  unitPriceDollars: string;
  minChargeDollars: string;
  isTaxable: boolean;
  category: 'service' | 'labor' | 'materials' | 'inventory' | 'other' | '';
  surfaceType: string;
  isActive: boolean;
};

const EMPTY: EditState = {
  name: '',
  description: '',
  pricingModel: 'fixed',
  unitLabel: '',
  unitPriceDollars: '',
  minChargeDollars: '',
  isTaxable: true,
  category: 'service',
  surfaceType: '',
  isActive: true,
};

function fromRow(row: CatalogItemRow): EditState {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    pricingModel: row.pricing_model,
    unitLabel: row.unit_label ?? '',
    unitPriceDollars: row.unit_price_cents == null ? '' : (row.unit_price_cents / 100).toFixed(2),
    minChargeDollars: row.min_charge_cents == null ? '' : (row.min_charge_cents / 100).toFixed(2),
    isTaxable: row.is_taxable,
    category: (row.category ?? 'service') as EditState['category'],
    surfaceType: row.surface_type ?? '',
    isActive: row.is_active,
  };
}

function priceLabel(row: CatalogItemRow): string {
  if (row.pricing_model === 'time_and_materials') return 'T&M';
  if (row.unit_price_cents == null) return '—';
  const formatted = formatCurrency(row.unit_price_cents);
  switch (row.pricing_model) {
    case 'fixed':
      return formatted;
    case 'per_unit':
      return `${formatted}/${row.unit_label ?? 'unit'}`;
    case 'hourly':
      return `${formatted}/hr`;
  }
}

export function PricebookManager({
  items,
  vertical,
  hasSeedsForVertical,
}: {
  items: CatalogItemRow[];
  vertical: string | null;
  hasSeedsForVertical: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<EditState | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const activeCount = useMemo(() => items.filter((i) => i.is_active).length, [items]);

  function startEdit(row: CatalogItemRow) {
    setEditing(fromRow(row));
    setIsAdding(false);
  }

  function startAdd() {
    setEditing({ ...EMPTY });
    setIsAdding(true);
  }

  function cancelEdit() {
    setEditing(null);
    setIsAdding(false);
  }

  function handleSave() {
    if (!editing) return;
    if (!editing.name.trim()) {
      toast.error('Name is required.');
      return;
    }

    const needsPrice = editing.pricingModel !== 'time_and_materials';
    let unitPriceCents: number | null = null;
    if (needsPrice) {
      const dollars = Number.parseFloat(editing.unitPriceDollars);
      if (!Number.isFinite(dollars) || dollars < 0) {
        toast.error('Enter a valid price.');
        return;
      }
      unitPriceCents = Math.round(dollars * 100);
    }

    let minChargeCents: number | null = null;
    if (editing.minChargeDollars.trim()) {
      const dollars = Number.parseFloat(editing.minChargeDollars);
      if (!Number.isFinite(dollars) || dollars < 0) {
        toast.error('Enter a valid minimum charge.');
        return;
      }
      minChargeCents = Math.round(dollars * 100);
    }

    const input: UpsertCatalogItemInput = {
      id: editing.id,
      name: editing.name.trim(),
      description: editing.description.trim() || null,
      pricingModel: editing.pricingModel,
      unitLabel: editing.unitLabel.trim() || null,
      unitPriceCents,
      minChargeCents,
      isTaxable: editing.isTaxable,
      category: editing.category || null,
      surfaceType: editing.surfaceType.trim() || null,
      isActive: editing.isActive,
    };

    startTransition(async () => {
      const result = await upsertCatalogItemAction(input);
      if (result.ok) {
        toast.success(editing.id ? 'Item updated.' : 'Item added.');
        setEditing(null);
        setIsAdding(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleToggleActive(row: CatalogItemRow) {
    startTransition(async () => {
      const result = row.is_active
        ? await deactivateCatalogItemAction(row.id)
        : await activateCatalogItemAction(row.id);
      if (result.ok) {
        toast.success(row.is_active ? 'Deactivated.' : 'Activated.');
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleSeed() {
    startTransition(async () => {
      const result = await seedPricebookFromVerticalAction();
      if (result.ok) {
        if (result.created === 0) {
          toast.info(`Starter pack already added (${result.skipped} items).`);
        } else {
          toast.success(`Added ${result.created} starter items.`);
        }
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  const showSeedButton = hasSeedsForVertical && items.length === 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Pricebook</CardTitle>
            <CardDescription>
              Your catalog of services, parts, and rates. Used on quotes and invoices.
              {vertical ? ` Tailored for ${vertical.replace(/_/g, ' ')}.` : ''}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {showSeedButton && (
              <Button size="sm" variant="outline" onClick={handleSeed} disabled={pending}>
                {pending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Sparkles className="size-3.5" />
                )}
                Add starter pack
              </Button>
            )}
            <Button size="sm" onClick={startAdd} disabled={isAdding}>
              <Plus className="size-3.5" />
              Add item
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Active</TableHead>
                <TableHead className="w-[60px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((row) => (
                <TableRow key={row.id} className={row.is_active ? '' : 'opacity-50'}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{row.name}</span>
                      {row.description && (
                        <span className="text-xs text-muted-foreground">{row.description}</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="font-normal">
                      {row.pricing_model === 'time_and_materials'
                        ? 'T&M'
                        : row.pricing_model === 'per_unit'
                          ? 'Per unit'
                          : row.pricing_model === 'hourly'
                            ? 'Hourly'
                            : 'Flat'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{priceLabel(row)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {row.category ?? '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <button
                      type="button"
                      onClick={() => handleToggleActive(row)}
                      disabled={pending}
                      className={`inline-block h-5 w-9 rounded-full transition-colors ${
                        row.is_active ? 'bg-emerald-500' : 'bg-muted'
                      }`}
                      aria-label={row.is_active ? 'Deactivate' : 'Activate'}
                    >
                      <span
                        className={`block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                          row.is_active ? 'translate-x-4' : 'translate-x-0.5'
                        }`}
                      />
                    </button>
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => startEdit(row)}
                      className="h-8 w-8 p-0"
                      aria-label="Edit"
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}

              {items.length === 0 && !editing && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No items yet.
                    {hasSeedsForVertical
                      ? ' Add a starter pack to bootstrap your pricebook, or add items manually.'
                      : ' Add your first item to get started.'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {editing && (
          <PricebookEditForm
            editing={editing}
            setEditing={setEditing}
            onSave={handleSave}
            onCancel={cancelEdit}
            pending={pending}
            isNew={isAdding}
          />
        )}

        {items.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {activeCount} active · {items.length - activeCount} archived
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function PricebookEditForm({
  editing,
  setEditing,
  onSave,
  onCancel,
  pending,
  isNew,
}: {
  editing: EditState;
  setEditing: (s: EditState) => void;
  onSave: () => void;
  onCancel: () => void;
  pending: boolean;
  isNew: boolean;
}) {
  const showPrice = editing.pricingModel !== 'time_and_materials';
  const showUnitLabel = editing.pricingModel === 'per_unit' || editing.pricingModel === 'hourly';

  return (
    <div className="space-y-4 rounded-lg border bg-muted/30 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{isNew ? 'Add item' : 'Edit item'}</h3>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          <X className="size-3.5" />
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="pb-name">Name</Label>
          <Input
            id="pb-name"
            value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            placeholder="e.g. Furnace tune-up"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="pb-model">Pricing</Label>
          <Select
            value={editing.pricingModel}
            onValueChange={(v) =>
              setEditing({
                ...editing,
                pricingModel: v as EditState['pricingModel'],
                // Clear price when switching to T&M; restore unit label default for per-unit
                unitPriceDollars: v === 'time_and_materials' ? '' : editing.unitPriceDollars,
                unitLabel:
                  v === 'hourly' ? 'hr' : v === 'per_unit' ? editing.unitLabel || 'sqft' : '',
              })
            }
          >
            <SelectTrigger id="pb-model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRICING_MODELS.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="pb-category">Category</Label>
          <Select
            value={editing.category}
            onValueChange={(v) => setEditing({ ...editing, category: v as EditState['category'] })}
          >
            <SelectTrigger id="pb-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {showPrice && (
          <div className="space-y-1.5">
            <Label htmlFor="pb-price">Price ($)</Label>
            <Input
              id="pb-price"
              type="number"
              min="0"
              step="0.01"
              value={editing.unitPriceDollars}
              onChange={(e) => setEditing({ ...editing, unitPriceDollars: e.target.value })}
              placeholder="0.00"
            />
          </div>
        )}

        {showUnitLabel && (
          <div className="space-y-1.5">
            <Label htmlFor="pb-unit">Unit</Label>
            <Input
              id="pb-unit"
              value={editing.unitLabel}
              onChange={(e) => setEditing({ ...editing, unitLabel: e.target.value })}
              placeholder={editing.pricingModel === 'hourly' ? 'hr' : 'sqft'}
              disabled={editing.pricingModel === 'hourly'}
            />
          </div>
        )}

        {editing.pricingModel === 'per_unit' && (
          <div className="space-y-1.5">
            <Label htmlFor="pb-min">Minimum charge ($) — optional</Label>
            <Input
              id="pb-min"
              type="number"
              min="0"
              step="0.01"
              value={editing.minChargeDollars}
              onChange={(e) => setEditing({ ...editing, minChargeDollars: e.target.value })}
              placeholder="0.00"
            />
          </div>
        )}

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="pb-desc">Description — optional</Label>
          <Input
            id="pb-desc"
            value={editing.description}
            onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            placeholder="Shown internally; not on invoices unless added to the line"
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={editing.isTaxable}
            onChange={(e) => setEditing({ ...editing, isTaxable: e.target.checked })}
            className="size-4 rounded border-input"
          />
          Taxable
        </label>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" onClick={onSave} disabled={pending}>
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Save className="size-3.5" />
            )}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
