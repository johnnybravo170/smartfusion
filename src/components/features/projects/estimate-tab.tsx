'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { CostLineRow } from '@/lib/db/queries/cost-lines';
import type { MaterialsCatalogRow } from '@/lib/db/queries/materials-catalog';
import { formatCurrency } from '@/lib/pricing/calculator';
import { createInvoiceFromEstimateAction } from '@/server/actions/invoices';
import { deleteCostLineAction } from '@/server/actions/project-cost-control';
import { CostLineForm } from './cost-line-form';

export function EstimateTab({
  projectId,
  costLines,
  catalog,
  managementFeeRate,
}: {
  projectId: string;
  costLines: CostLineRow[];
  catalog: MaterialsCatalogRow[];
  managementFeeRate: number;
}) {
  const [showForm, setShowForm] = useState(false);
  const [editingLine, setEditingLine] = useState<CostLineRow | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function deleteLine(id: string) {
    if (!confirm('Delete this line?')) return;
    startTransition(async () => {
      await deleteCostLineAction(id, projectId);
    });
  }

  function createInvoice() {
    startTransition(async () => {
      const res = await createInvoiceFromEstimateAction({ projectId });
      if (res.ok && res.id) {
        toast.success('Invoice created');
        router.push(`/invoices/${res.id}`);
      } else if (!res.ok) {
        toast.error(res.error);
      }
    });
  }

  const totalCost = costLines.reduce((s, l) => s + l.line_cost_cents, 0);
  const totalPrice = costLines.reduce((s, l) => s + l.line_price_cents, 0);
  const mgmtFeeCents = Math.round(totalPrice * managementFeeRate);
  const grandTotal = totalPrice + mgmtFeeCents;

  const grouped = costLines.reduce<Record<string, CostLineRow[]>>((acc, line) => {
    const bucket = acc[line.category] ?? [];
    bucket.push(line);
    acc[line.category] = bucket;
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      {showForm || editingLine ? (
        <CostLineForm
          projectId={projectId}
          initial={editingLine ?? undefined}
          catalog={catalog}
          onDone={() => {
            setShowForm(false);
            setEditingLine(null);
          }}
        />
      ) : (
        <Button size="sm" onClick={() => setShowForm(true)}>
          + Add line
        </Button>
      )}

      {costLines.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No cost lines yet. Add your first item above.
        </p>
      ) : (
        <div className="space-y-4">
          {Object.entries(grouped).map(([cat, lines]) => (
            <div key={cat}>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground capitalize">
                {cat}
              </h4>
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
                          {line.notes && (
                            <p className="text-xs text-muted-foreground">{line.notes}</p>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">{Number(line.qty)}</td>
                        <td className="px-3 py-2 text-muted-foreground">{line.unit}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">
                          {formatCurrency(line.unit_cost_cents)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {formatCurrency(line.unit_price_cents)}
                        </td>
                        <td className="px-3 py-2 text-right font-medium">
                          {formatCurrency(line.line_price_cents)}
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground">
                          {Number(line.markup_pct).toFixed(1)}%
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => {
                                setEditingLine(line);
                                setShowForm(false);
                              }}
                            >
                              Edit
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              className="text-destructive hover:text-destructive"
                              onClick={() => deleteLine(line.id)}
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
            </div>
          ))}

          <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm">
            <div className="flex justify-end gap-8">
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Subtotal</p>
                <p className="font-medium">{formatCurrency(totalPrice)}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-muted-foreground">
                  Management fee ({Math.round(managementFeeRate * 100)}%)
                </p>
                <p className="font-medium">{formatCurrency(mgmtFeeCents)}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Total</p>
                <p className="font-semibold text-primary">{formatCurrency(grandTotal)}</p>
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
            <div className="mt-3 flex justify-end">
              <Button size="sm" onClick={createInvoice} disabled={isPending}>
                Create invoice from estimate
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
