'use client';

/**
 * Service catalog management for the settings page. Inline editing of
 * surface types and pricing.
 */

import { Loader2, Pencil, Plus, Save, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { CatalogEntryRow } from '@/lib/db/queries/service-catalog';
import { upsertCatalogEntryAction } from '@/server/actions/quotes';

type EditState = {
  id?: string;
  surface_type: string;
  label: string;
  price_per_sqft_cents: string;
  min_charge_cents: string;
};

const EMPTY_EDIT: EditState = {
  surface_type: '',
  label: '',
  price_per_sqft_cents: '',
  min_charge_cents: '',
};

export function CatalogManager({ entries }: { entries: CatalogEntryRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<EditState | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  function startEdit(entry: CatalogEntryRow) {
    setEditing({
      id: entry.id,
      surface_type: entry.surface_type,
      label: entry.label,
      price_per_sqft_cents: (entry.price_per_sqft_cents / 100).toFixed(2),
      min_charge_cents: (entry.min_charge_cents / 100).toFixed(2),
    });
    setIsAdding(false);
  }

  function startAdd() {
    setEditing({ ...EMPTY_EDIT });
    setIsAdding(true);
  }

  function cancelEdit() {
    setEditing(null);
    setIsAdding(false);
  }

  function handleSave() {
    if (!editing) return;

    const priceDollars = Number.parseFloat(editing.price_per_sqft_cents);
    const minDollars = Number.parseFloat(editing.min_charge_cents);

    if (!editing.surface_type.trim() || !editing.label.trim()) {
      toast.error('Type key and label are required.');
      return;
    }
    if (Number.isNaN(priceDollars) || priceDollars < 0) {
      toast.error('Enter a valid price per sq ft.');
      return;
    }
    if (Number.isNaN(minDollars) || minDollars < 0) {
      toast.error('Enter a valid minimum charge.');
      return;
    }

    startTransition(async () => {
      const result = await upsertCatalogEntryAction({
        id: editing.id,
        surface_type: editing.surface_type.trim().toLowerCase().replace(/\s+/g, '_'),
        label: editing.label.trim(),
        price_per_sqft_cents: Math.round(priceDollars * 100),
        min_charge_cents: Math.round(minDollars * 100),
        is_active: true,
      });

      if (result.ok) {
        toast.success(isAdding ? 'Surface type added.' : 'Surface type updated.');
        setEditing(null);
        setIsAdding(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleToggleActive(entry: CatalogEntryRow) {
    startTransition(async () => {
      const result = await upsertCatalogEntryAction({
        id: entry.id,
        surface_type: entry.surface_type,
        label: entry.label,
        price_per_sqft_cents: entry.price_per_sqft_cents,
        min_charge_cents: entry.min_charge_cents,
        is_active: !entry.is_active,
      });
      if (result.ok) {
        toast.success(entry.is_active ? 'Deactivated.' : 'Activated.');
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Service Catalog</CardTitle>
            <CardDescription>
              Surface types and pricing for your quotes. Customers see the label.
            </CardDescription>
          </div>
          <Button size="sm" onClick={startAdd} disabled={isAdding}>
            <Plus className="size-3.5" />
            Add type
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Key</TableHead>
                <TableHead className="text-right">$/sq ft</TableHead>
                <TableHead className="text-right">Min charge</TableHead>
                <TableHead className="text-right">Active</TableHead>
                <TableHead className="w-[80px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) =>
                editing?.id === entry.id ? (
                  <EditRow
                    key={entry.id}
                    editing={editing}
                    setEditing={setEditing}
                    onSave={handleSave}
                    onCancel={cancelEdit}
                    pending={pending}
                  />
                ) : (
                  <TableRow key={entry.id}>
                    <TableCell className="font-medium">{entry.label}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {entry.surface_type}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      ${(entry.price_per_sqft_cents / 100).toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      ${(entry.min_charge_cents / 100).toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right">
                      <button
                        type="button"
                        onClick={() => handleToggleActive(entry)}
                        disabled={pending}
                        className={`inline-block h-5 w-9 rounded-full transition-colors ${
                          entry.is_active ? 'bg-emerald-500' : 'bg-muted'
                        }`}
                      >
                        <span
                          className={`block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                            entry.is_active ? 'translate-x-4' : 'translate-x-0.5'
                          }`}
                        />
                      </button>
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => startEdit(entry)}
                        className="h-8 w-8 p-0"
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ),
              )}

              {isAdding && editing && !editing.id && (
                <EditRow
                  editing={editing}
                  setEditing={setEditing}
                  onSave={handleSave}
                  onCancel={cancelEdit}
                  pending={pending}
                />
              )}

              {entries.length === 0 && !isAdding && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                    No surface types configured. Add one to start quoting.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function EditRow({
  editing,
  setEditing,
  onSave,
  onCancel,
  pending,
}: {
  editing: EditState;
  setEditing: (s: EditState) => void;
  onSave: () => void;
  onCancel: () => void;
  pending: boolean;
}) {
  return (
    <TableRow>
      <TableCell>
        <Input
          value={editing.label}
          onChange={(e) => {
            const label = e.target.value;
            const update: Record<string, string> = { label };
            // Auto-populate the key from the label (only for new entries)
            if (!editing.id) {
              update.surface_type = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
            }
            setEditing({ ...editing, ...update });
          }}
          placeholder="Driveway"
          className="h-8"
        />
      </TableCell>
      <TableCell>
        <Input
          value={editing.surface_type}
          onChange={(e) => setEditing({ ...editing, surface_type: e.target.value })}
          placeholder="driveway"
          className="h-8 font-mono text-xs"
          disabled={!!editing.id}
        />
      </TableCell>
      <TableCell>
        <Input
          type="number"
          min="0"
          step="0.01"
          value={editing.price_per_sqft_cents}
          onChange={(e) => setEditing({ ...editing, price_per_sqft_cents: e.target.value })}
          placeholder="0.15"
          className="h-8 text-right"
        />
      </TableCell>
      <TableCell>
        <Input
          type="number"
          min="0"
          step="0.01"
          value={editing.min_charge_cents}
          onChange={(e) => setEditing({ ...editing, min_charge_cents: e.target.value })}
          placeholder="50.00"
          className="h-8 text-right"
        />
      </TableCell>
      <TableCell />
      <TableCell>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onSave}
            disabled={pending}
            className="h-8 w-8 p-0"
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Save className="size-3.5" />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={pending}
            className="h-8 w-8 p-0"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
