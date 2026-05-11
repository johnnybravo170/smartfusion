'use client';

/**
 * Quote create/edit form. Combines customer picker, address/map, surface list,
 * and manual entry fallback. The same component powers `/quotes/new` and
 * `/quotes/[id]/edit`.
 */

import { MapPin, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { CustomerPicker } from '@/components/features/customers/customer-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useHenryForm } from '@/hooks/use-henry-form';
import type { MapQuoteCatalogEntry } from '@/lib/db/queries/catalog-items';
import { calculateQuoteTotal, calculateSurfacePrice } from '@/lib/pricing/calculator';
import type { QuoteActionResult } from '@/server/actions/quotes';
import { QuoteMap } from './quote-map';
import { type SurfaceEntry, SurfaceList } from './surface-list';

export type QuoteFormCustomerOption = {
  id: string;
  name: string;
};

type ExistingSurface = {
  id: string;
  surface_type: string;
  polygon_geojson?: unknown;
  sqft: number;
  price_cents: number;
  notes?: string;
};

export type QuoteFormDefaults = {
  id?: string;
  customer_id?: string;
  notes?: string;
  surfaces?: ExistingSurface[];
};

export type QuoteFormProps = {
  mode: 'create' | 'edit';
  customers: QuoteFormCustomerOption[];
  catalog: MapQuoteCatalogEntry[];
  /** Combined tax rate for live preview (e.g. 0.05 AB GST, 0.13 ON HST).
   *  Server recomputes authoritatively at submission, including
   *  tax-exempt zeroing — preview is informational only. */
  taxRate: number;
  defaults?: QuoteFormDefaults;
  action: (input: unknown) => Promise<QuoteActionResult>;
  submitLabel?: string;
  cancelHref?: string;
};

export function QuoteForm({
  mode,
  customers,
  catalog,
  taxRate,
  defaults,
  action,
  submitLabel,
  cancelHref,
}: QuoteFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState(defaults?.customer_id ?? '');
  const [notes, setNotes] = useState(defaults?.notes ?? '');
  const [surfaces, setSurfaces] = useState<SurfaceEntry[]>(() => {
    if (!defaults?.surfaces) return [];
    return defaults.surfaces.map((s) => {
      const entry = catalog.find((c) => c.surface_type === s.surface_type);
      return {
        id: s.id ?? crypto.randomUUID(),
        surface_type: s.surface_type,
        label: entry?.label ?? s.surface_type,
        sqft: s.sqft,
        price_cents: s.price_cents,
        polygon_geojson: s.polygon_geojson,
        notes: s.notes,
      };
    });
  });

  // Manual entry state.
  const [useManualEntry, setUseManualEntry] = useState(false);
  const [manualType, setManualType] = useState(catalog[0]?.surface_type ?? '');
  const [manualSqft, setManualSqft] = useState('');

  const totals = useMemo(() => {
    return calculateQuoteTotal(surfaces, taxRate);
  }, [surfaces, taxRate]);

  const selectedCustomer = customers.find((c) => c.id === customerId);

  useHenryForm({
    formId: mode === 'create' ? 'quote-create' : `quote-edit-${defaults?.id ?? ''}`,
    title: mode === 'create' ? 'Creating a new quote' : 'Editing a quote',
    fields: [
      {
        name: 'customer_id',
        label: 'Customer',
        type: 'text',
        description:
          'Give the customer name; setField resolves to the UUID. If no match, call list_customers first.',
        currentValue: selectedCustomer?.name ?? customerId,
      },
      {
        name: 'notes',
        label: 'Notes (visible to the customer)',
        type: 'textarea',
        currentValue: notes,
      },
    ],
    setField: (name, value) => {
      if (name === 'customer_id') {
        if (customers.some((c) => c.id === value)) {
          setCustomerId(value);
          return true;
        }
        const needle = value.trim().toLowerCase();
        const match = customers.find((c) => c.name.toLowerCase().includes(needle));
        if (match) {
          setCustomerId(match.id);
          return true;
        }
        return false;
      }
      if (name === 'notes') {
        setNotes(value);
        return true;
      }
      return false;
    },
    // Surfaces are drawn on a map or entered numerically — not safe to submit
    // programmatically from voice yet. Operator submits manually.
  });

  const handleSurfaceAdd = useCallback(
    (surface: {
      id: string;
      surface_type: string;
      label: string;
      sqft: number;
      price_cents: number;
      polygon_geojson?: unknown;
    }) => {
      setSurfaces((prev) => [...prev, { ...surface, notes: '' }]);
    },
    [],
  );

  const handleSurfaceRemove = useCallback((id: string) => {
    setSurfaces((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const handleManualAdd = useCallback(() => {
    const sqft = Number.parseFloat(manualSqft);
    if (!manualType || Number.isNaN(sqft) || sqft <= 0) {
      toast.error('Enter a valid surface type and area.');
      return;
    }

    const entry = catalog.find((c) => c.surface_type === manualType);
    if (!entry) {
      toast.error('Surface type not found in catalog.');
      return;
    }

    const price_cents = calculateSurfacePrice({ surface_type: manualType, sqft }, entry);

    const id = crypto.randomUUID();
    setSurfaces((prev) => [
      ...prev,
      {
        id,
        surface_type: manualType,
        label: entry.label,
        sqft,
        price_cents,
        notes: '',
      },
    ]);
    setManualSqft('');
  }, [manualType, manualSqft, catalog]);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);

    if (!customerId) {
      setFormError('Pick a customer.');
      return;
    }
    if (surfaces.length === 0) {
      setFormError('Add at least one surface.');
      return;
    }

    startTransition(async () => {
      const payload = {
        ...(defaults?.id ? { id: defaults.id } : {}),
        customer_id: customerId,
        notes,
        surfaces: surfaces.map((s) => ({
          surface_type: s.surface_type,
          polygon_geojson: s.polygon_geojson,
          sqft: s.sqft,
          price_cents: s.price_cents,
          notes: s.notes,
        })),
      };

      const result = await action(payload);

      if (result.ok) {
        toast.success(mode === 'create' ? 'Quote saved as draft.' : 'Quote updated.');
        router.push(`/quotes/${result.id}`);
        router.refresh();
        return;
      }

      setFormError(result.error);
      toast.error(result.error);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6" aria-busy={pending || undefined}>
      {/* Customer picker */}
      <div className="rounded-xl border bg-card p-4">
        <span className="mb-2 block text-sm font-medium">Customer</span>
        <CustomerPicker
          customers={customers}
          value={customerId}
          onChange={setCustomerId}
          placeholder="Pick a customer"
        />
      </div>

      {/* Map or toggle */}
      <div className="rounded-xl border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MapPin className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">Surfaces</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setUseManualEntry((v) => !v)}
          >
            {useManualEntry ? 'Show map' : 'Manual entry'}
          </Button>
        </div>

        {!useManualEntry ? (
          <QuoteMap
            catalog={catalog}
            onSurfaceAdd={handleSurfaceAdd}
            onSurfaceRemove={handleSurfaceRemove}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              Add surfaces manually. Pick a type and enter the area in square feet.
            </p>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">
                  Surface type
                </span>
                <Select value={manualType} onValueChange={setManualType}>
                  <SelectTrigger>
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent>
                    {catalog.map((c) => (
                      <SelectItem key={c.surface_type} value={c.surface_type}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="w-[120px]">
                <label
                  htmlFor="manual-sqft"
                  className="mb-1 block text-xs font-medium text-muted-foreground"
                >
                  Sq ft
                </label>
                <Input
                  id="manual-sqft"
                  type="number"
                  min="0"
                  step="0.1"
                  value={manualSqft}
                  onChange={(e) => setManualSqft(e.target.value)}
                  placeholder="0.0"
                />
              </div>
              <Button type="button" size="sm" onClick={handleManualAdd}>
                <Plus className="size-3.5" />
                Add
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Surface breakdown */}
      <SurfaceList
        surfaces={surfaces}
        subtotalCents={totals.subtotal_cents}
        taxCents={totals.tax_cents}
        totalCents={totals.total_cents}
        taxRate={taxRate}
        onRemove={handleSurfaceRemove}
      />

      {/* Manual add in map mode too */}
      {!useManualEntry && catalog.length > 0 && (
        <div className="rounded-xl border bg-card p-4">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Or add a surface manually (for phone quotes):
          </p>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Select value={manualType} onValueChange={setManualType}>
                <SelectTrigger>
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  {catalog.map((c) => (
                    <SelectItem key={c.surface_type} value={c.surface_type}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-[120px]">
              <Input
                type="number"
                min="0"
                step="0.1"
                value={manualSqft}
                onChange={(e) => setManualSqft(e.target.value)}
                placeholder="Sq ft"
              />
            </div>
            <Button type="button" size="sm" onClick={handleManualAdd}>
              <Plus className="size-3.5" />
              Add
            </Button>
          </div>
        </div>
      )}

      {/* Notes */}
      <div className="rounded-xl border bg-card p-4">
        <label htmlFor="quote-notes" className="mb-2 block text-sm font-medium">
          Notes
        </label>
        <Textarea
          id="quote-notes"
          rows={4}
          placeholder="Any details for the customer (access instructions, special conditions, etc.)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      {formError ? (
        <p className="text-sm text-destructive" role="alert">
          {formError}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending
            ? mode === 'create'
              ? 'Saving...'
              : 'Updating...'
            : (submitLabel ?? (mode === 'create' ? 'Save as draft' : 'Save changes'))}
        </Button>
        {cancelHref ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => router.push(cancelHref)}
            disabled={pending}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
