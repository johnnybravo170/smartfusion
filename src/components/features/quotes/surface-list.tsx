'use client';

/**
 * Surfaces breakdown table for the quote form. Shows each drawn/entered surface
 * with type, area, price, and a delete button. Running totals at the bottom.
 */

import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency } from '@/lib/pricing/calculator';

export type SurfaceEntry = {
  id: string;
  surface_type: string;
  label: string;
  sqft: number;
  price_cents: number;
  polygon_geojson?: unknown;
  notes?: string;
};

type SurfaceListProps = {
  surfaces: SurfaceEntry[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  onRemove?: (id: string) => void;
  readOnly?: boolean;
  showPricing?: boolean;
};

export function SurfaceList({
  surfaces,
  subtotalCents,
  taxCents,
  totalCents,
  onRemove,
  readOnly = false,
  showPricing = true,
}: SurfaceListProps) {
  if (surfaces.length === 0) {
    return (
      <div className="rounded-xl border border-dashed bg-card p-6 text-center">
        <p className="text-sm text-muted-foreground">
          No surfaces added yet. Use the map to draw polygons or add manually below.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Surface</TableHead>
            <TableHead className="text-right">Area (sq ft)</TableHead>
            {showPricing && <TableHead className="text-right">Price</TableHead>}
            {!readOnly && <TableHead className="w-[50px]" />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {surfaces.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="font-medium">
                <span>
                  {s.label ||
                    s.surface_type.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())}
                </span>
                {s.polygon_geojson === null && (
                  <span className="ml-2 text-xs italic text-muted-foreground">
                    Auto-detected via Solar API
                  </span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{s.sqft.toFixed(1)}</TableCell>
              {showPricing && (
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(s.price_cents)}
                </TableCell>
              )}
              {!readOnly && onRemove && (
                <TableCell>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onRemove(s.id)}
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {showPricing && (
        <div className="border-t px-4 py-3">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Subtotal</span>
            <span className="tabular-nums">{formatCurrency(subtotalCents)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">GST (5%)</span>
            <span className="tabular-nums">{formatCurrency(taxCents)}</span>
          </div>
          <div className="mt-1 flex justify-between border-t pt-2 text-base font-semibold">
            <span>Total</span>
            <span className="tabular-nums">{formatCurrency(totalCents)}</span>
          </div>
        </div>
      )}
      {!showPricing && surfaces.length > 0 && (
        <div className="border-t px-4 py-3 text-center">
          <p className="text-sm text-muted-foreground">Enter your details to see your estimate.</p>
        </div>
      )}
    </div>
  );
}
