'use client';

/**
 * Public-facing quoting widget for lead capture.
 *
 * Reuses the existing QuoteMap and SurfaceList components from the operator
 * quoting engine, but wraps them in a multi-step lead-capture flow:
 *
 *   Step 1: Address + surfaces (map or manual entry)
 *   Step 2: Contact info (name, email, phone)
 *   Step 3: Confirmation
 *
 * Key differences from operator quoting:
 *   - No auth required
 *   - No customer picker (the homeowner IS the customer)
 *   - Submits via the lead-gen server action (admin client)
 */

import { MapPin, Plus } from 'lucide-react';
import { useCallback, useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { QuoteMap } from '@/components/features/quotes/quote-map';
import { type SurfaceEntry, SurfaceList } from '@/components/features/quotes/surface-list';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { MapQuoteCatalogEntry } from '@/lib/db/queries/catalog-items';
import { calculateQuoteTotal, calculateSurfacePrice } from '@/lib/pricing/calculator';

/**
 * Catalog entry shape consumed by the public quote form. Mapped from
 * `catalog_items` at the page boundary. Re-exports `MapQuoteCatalogEntry`
 * so the public page boundary has a single import for the shape.
 */
export type PublicQuoteCatalogEntry = MapQuoteCatalogEntry;

import { submitLeadAction } from '@/server/actions/lead-gen';
import { LeadCaptureForm } from './lead-capture-form';
import { LeadConfirmation } from './lead-confirmation';

type PublicQuoteFormProps = {
  tenantId: string;
  businessName: string;
  catalog: PublicQuoteCatalogEntry[];
  /** Combined tax rate for live preview (e.g. 0.05 AB GST, 0.13 ON HST).
   *  Server recomputes authoritatively at submission. */
  taxRate: number;
};

type Step = 'surfaces' | 'contact' | 'done';

export function PublicQuoteForm({
  tenantId,
  businessName,
  catalog,
  taxRate,
}: PublicQuoteFormProps) {
  const [step, setStep] = useState<Step>('surfaces');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Surface state.
  const [surfaces, setSurfaces] = useState<SurfaceEntry[]>([]);
  const [useManualEntry, setUseManualEntry] = useState(false);
  const [manualType, setManualType] = useState(catalog[0]?.surface_type ?? '');
  const [manualSqft, setManualSqft] = useState('');

  const totals = useMemo(() => calculateQuoteTotal(surfaces, taxRate), [surfaces, taxRate]);

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

  function handleGetQuote() {
    if (surfaces.length === 0) {
      setError('Add at least one surface to get an estimate.');
      return;
    }
    setError(null);
    setStep('contact');
  }

  function handleContactSubmit(data: {
    name: string;
    email: string;
    phone: string;
    notes: string;
    marketingOptIn: boolean;
    marketingWording: string;
  }) {
    setError(null);
    startTransition(async () => {
      const result = await submitLeadAction({
        tenantId,
        name: data.name,
        email: data.email,
        phone: data.phone,
        notes: data.notes || undefined,
        marketingOptIn: data.marketingOptIn,
        marketingWording: data.marketingWording,
        surfaces: surfaces.map((s) => ({
          surface_type: s.surface_type,
          sqft: s.sqft,
          price_cents: s.price_cents,
          polygon_geojson: s.polygon_geojson,
        })),
      });

      if (result.ok) {
        setStep('done');
      } else {
        setError(result.error ?? 'Something went wrong. Please try again.');
      }
    });
  }

  // Step 3: Confirmation.
  if (step === 'done') {
    return <LeadConfirmation businessName={businessName} totalCents={totals.total_cents} />;
  }

  // Step 2: Contact info.
  if (step === 'contact') {
    return (
      <div className="flex flex-col gap-6">
        <div className="rounded-xl border bg-card p-4">
          <h3 className="mb-1 text-sm font-medium">Almost there!</h3>
          <p className="text-sm text-muted-foreground">
            Enter your details below and we'll show you your estimate instantly.
          </p>
        </div>

        <div className="rounded-xl border bg-card p-4">
          <h3 className="mb-4 text-sm font-medium">Your contact details</h3>
          <LeadCaptureForm onSubmit={handleContactSubmit} pending={pending} error={error} />
        </div>

        <Button type="button" variant="ghost" onClick={() => setStep('surfaces')}>
          Back
        </Button>
      </div>
    );
  }

  // Step 1: Address + surfaces.
  return (
    <div className="flex flex-col gap-6">
      {/* Map or manual entry */}
      <div className="rounded-xl border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MapPin className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">Your property</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setUseManualEntry((v) => !v)}
          >
            {useManualEntry ? 'Show map' : 'Enter manually'}
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
              Pick a surface type and enter the approximate area in square feet.
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
                  htmlFor="public-manual-sqft"
                  className="mb-1 block text-xs font-medium text-muted-foreground"
                >
                  Sq ft
                </label>
                <Input
                  id="public-manual-sqft"
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

      {/* Manual add in map mode */}
      {!useManualEntry && catalog.length > 0 && (
        <div className="rounded-xl border bg-card p-4">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Or add a surface manually:
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

      {/* Surface breakdown — pricing hidden until contact info submitted */}
      <SurfaceList
        surfaces={surfaces}
        subtotalCents={totals.subtotal_cents}
        taxCents={totals.tax_cents}
        totalCents={totals.total_cents}
        taxRate={taxRate}
        onRemove={handleSurfaceRemove}
        showPricing={false}
      />

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <Button
        type="button"
        size="lg"
        className="w-full"
        onClick={handleGetQuote}
        disabled={surfaces.length === 0}
      >
        Get your free estimate
      </Button>
    </div>
  );
}
