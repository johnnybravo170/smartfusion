'use client';

/**
 * Cost buckets table with inline editing for the project detail page.
 */

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { BudgetLine } from '@/lib/db/queries/project-buckets';
import { formatCurrency } from '@/lib/pricing/calculator';
import { cn } from '@/lib/utils';
import { updateBucketAction } from '@/server/actions/project-buckets';

type CostBucketsTableProps = {
  lines: BudgetLine[];
  projectId: string;
};

export function CostBucketsTable({ lines, projectId }: CostBucketsTableProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [isPending, startTransition] = useTransition();

  // Group by section
  const sections = new Map<string, BudgetLine[]>();
  for (const line of lines) {
    const existing = sections.get(line.section) ?? [];
    existing.push(line);
    sections.set(line.section, existing);
  }

  function startEdit(line: BudgetLine) {
    setEditingId(line.bucket_id);
    setEditValue(String(line.estimate_cents / 100));
  }

  function saveEdit(bucketId: string) {
    const cents = Math.round(Number(editValue) * 100);
    if (Number.isNaN(cents) || cents < 0) {
      toast.error('Invalid amount');
      return;
    }
    startTransition(async () => {
      const result = await updateBucketAction({
        id: bucketId,
        project_id: projectId,
        estimate_cents: cents,
      });
      if (result.ok) {
        toast.success('Estimate updated');
        setEditingId(null);
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="space-y-6">
      {Array.from(sections.entries()).map(([section, sectionLines]) => {
        const sectionTotal = sectionLines.reduce((s, l) => s + l.estimate_cents, 0);
        const sectionActual = sectionLines.reduce((s, l) => s + l.actual_cents, 0);

        return (
          <div key={section}>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              {section}
            </h3>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2 text-left font-medium">Bucket</th>
                    <th className="px-3 py-2 text-right font-medium">Estimate</th>
                    <th className="px-3 py-2 text-right font-medium">Actual</th>
                    <th className="px-3 py-2 text-right font-medium">Remaining</th>
                    <th className="px-3 py-2 text-right font-medium w-32">Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {sectionLines.map((line) => {
                    const progress =
                      line.estimate_cents > 0
                        ? Math.min(Math.round((line.actual_cents / line.estimate_cents) * 100), 100)
                        : 0;
                    const isOver = line.remaining_cents < 0;

                    return (
                      <tr key={line.bucket_id} className="border-b last:border-0">
                        <td className="px-3 py-2">{line.bucket_name}</td>
                        <td className="px-3 py-2 text-right">
                          {editingId === line.bucket_id ? (
                            <div className="flex items-center justify-end gap-1">
                              <span className="text-muted-foreground">$</span>
                              <Input
                                type="number"
                                step="0.01"
                                className="w-24 h-7 text-right text-sm"
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') saveEdit(line.bucket_id);
                                  if (e.key === 'Escape') setEditingId(null);
                                }}
                                autoFocus
                              />
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2"
                                disabled={isPending}
                                onClick={() => saveEdit(line.bucket_id)}
                              >
                                Save
                              </Button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="hover:underline cursor-pointer"
                              onClick={() => startEdit(line)}
                            >
                              {formatCurrency(line.estimate_cents)}
                            </button>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {formatCurrency(line.actual_cents)}
                        </td>
                        <td
                          className={cn(
                            'px-3 py-2 text-right',
                            isOver && 'text-red-600 font-medium',
                          )}
                        >
                          {formatCurrency(Math.abs(line.remaining_cents))}
                          {isOver ? ' over' : ''}
                        </td>
                        <td className="px-3 py-2">
                          <div className="h-1.5 w-full rounded-full bg-gray-200">
                            <div
                              className={cn(
                                'h-full rounded-full',
                                isOver
                                  ? 'bg-red-500'
                                  : progress > 80
                                    ? 'bg-yellow-500'
                                    : 'bg-green-500',
                              )}
                              style={{ width: `${Math.min(progress, 100)}%` }}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-muted/30 font-medium">
                    <td className="px-3 py-2">
                      {section.charAt(0).toUpperCase() + section.slice(1)} Total
                    </td>
                    <td className="px-3 py-2 text-right">{formatCurrency(sectionTotal)}</td>
                    <td className="px-3 py-2 text-right">{formatCurrency(sectionActual)}</td>
                    <td className="px-3 py-2 text-right">
                      {formatCurrency(Math.abs(sectionTotal - sectionActual))}
                      {sectionTotal - sectionActual < 0 ? ' over' : ''}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
