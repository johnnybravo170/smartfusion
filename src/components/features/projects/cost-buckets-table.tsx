'use client';

/**
 * Cost buckets table for the project detail page.
 *
 * Inline estimate editing, add/remove buckets, expandable rows showing the
 * cost lines associated with each bucket, and a one-click "generate estimate
 * from buckets" button that seeds cost lines from bucket estimates.
 */

import { Check, ChevronDown, ChevronRight, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CostLineRow } from '@/lib/db/queries/cost-lines';
import type { MaterialsCatalogRow } from '@/lib/db/queries/materials-catalog';
import type { BudgetLine } from '@/lib/db/queries/project-buckets';
import { formatCurrency, formatCurrencyCompact } from '@/lib/pricing/calculator';
import { cn } from '@/lib/utils';
import {
  addBucketAction,
  removeBucketAction,
  updateBucketAction,
} from '@/server/actions/project-buckets';
import {
  deleteCostLineAction,
  generateEstimateFromBucketsAction,
} from '@/server/actions/project-cost-control';
import { CostLineForm } from './cost-line-form';

type CostBucketsTableProps = {
  lines: BudgetLine[];
  projectId: string;
  costLines: CostLineRow[];
  catalog: MaterialsCatalogRow[];
};

export function CostBucketsTable({ lines, projectId, costLines, catalog }: CostBucketsTableProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [addingLineFor, setAddingLineFor] = useState<string | null>(null);
  const [editingLine, setEditingLine] = useState<CostLineRow | null>(null);
  const [showAddBucket, setShowAddBucket] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const sections = new Map<string, BudgetLine[]>();
  for (const line of lines) {
    const existing = sections.get(line.section) ?? [];
    existing.push(line);
    sections.set(line.section, existing);
  }

  const linesByBucket = new Map<string, CostLineRow[]>();
  for (const cl of costLines) {
    if (!cl.bucket_id) continue;
    const arr = linesByBucket.get(cl.bucket_id) ?? [];
    arr.push(cl);
    linesByBucket.set(cl.bucket_id, arr);
  }

  function toggleExpand(bucketId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(bucketId)) next.delete(bucketId);
      else next.add(bucketId);
      return next;
    });
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

  function removeBucket(bucketId: string) {
    if (!confirm('Remove this category? Any line items attached will be orphaned.')) return;
    startTransition(async () => {
      const result = await removeBucketAction({ id: bucketId, project_id: projectId });
      if (result.ok) toast.success('Bucket removed');
      else toast.error(result.error);
    });
  }

  function deleteLine(id: string) {
    if (!confirm('Delete this line?')) return;
    startTransition(async () => {
      await deleteCostLineAction(id, projectId);
    });
  }

  function generateEstimate() {
    startTransition(async () => {
      const res = await generateEstimateFromBucketsAction({ project_id: projectId });
      if (res.ok) {
        toast.success(`Seeded ${res.count} line${res.count === 1 ? '' : 's'} from buckets`);
        router.push(`/projects/${projectId}?tab=estimate`);
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setShowAddBucket((v) => !v)}>
          {showAddBucket ? 'Cancel' : '+ Add category'}
        </Button>
        <Button size="sm" variant="outline" onClick={generateEstimate} disabled={isPending}>
          Generate Estimate
        </Button>
      </div>

      {showAddBucket && (
        <AddBucketForm projectId={projectId} onDone={() => setShowAddBucket(false)} />
      )}

      {Array.from(sections.entries()).map(([section, sectionLines]) => {
        const sectionTotal = sectionLines.reduce((s, l) => s + l.estimate_cents, 0);
        const sectionActual = sectionLines.reduce((s, l) => s + l.actual_cents, 0);

        return (
          <div key={section}>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              {section}
            </h3>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full table-fixed text-sm">
                <colgroup>
                  <col className="w-8" />
                  <col />
                  <col className="w-44" />
                  <col className="w-28" />
                  <col className="w-32" />
                  <col className="w-32" />
                  <col className="w-10" />
                </colgroup>
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-2 py-2" />
                    <th className="px-3 py-2 text-left font-medium">Category</th>
                    <th className="px-3 py-2 text-right font-medium">Estimate</th>
                    <th className="px-3 py-2 text-right font-medium">Actual</th>
                    <th className="px-3 py-2 text-right font-medium">Remaining</th>
                    <th className="px-3 py-2 text-right font-medium">Progress</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {sectionLines.map((line) => {
                    const progress =
                      line.estimate_cents > 0
                        ? Math.min(Math.round((line.actual_cents / line.estimate_cents) * 100), 100)
                        : 0;
                    const isOver = line.remaining_cents < 0;
                    const isExpanded = expanded.has(line.bucket_id);
                    const bucketLines = linesByBucket.get(line.bucket_id) ?? [];

                    return (
                      <BucketRow
                        key={line.bucket_id}
                        line={line}
                        progress={progress}
                        isOver={isOver}
                        isExpanded={isExpanded}
                        bucketLines={bucketLines}
                        editingId={editingId}
                        editValue={editValue}
                        setEditValue={setEditValue}
                        setEditingId={setEditingId}
                        isPending={isPending}
                        saveEdit={saveEdit}
                        startEdit={startEdit}
                        toggleExpand={toggleExpand}
                        removeBucket={removeBucket}
                        addingLineFor={addingLineFor}
                        setAddingLineFor={setAddingLineFor}
                        editingLine={editingLine}
                        setEditingLine={setEditingLine}
                        deleteLine={deleteLine}
                        projectId={projectId}
                        catalog={catalog}
                      />
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-muted/30 font-medium">
                    <td />
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

type BucketRowProps = {
  line: BudgetLine;
  progress: number;
  isOver: boolean;
  isExpanded: boolean;
  bucketLines: CostLineRow[];
  editingId: string | null;
  editValue: string;
  setEditValue: (v: string) => void;
  setEditingId: (v: string | null) => void;
  isPending: boolean;
  saveEdit: (id: string) => void;
  startEdit: (line: BudgetLine) => void;
  toggleExpand: (id: string) => void;
  removeBucket: (id: string) => void;
  addingLineFor: string | null;
  setAddingLineFor: (v: string | null) => void;
  editingLine: CostLineRow | null;
  setEditingLine: (v: CostLineRow | null) => void;
  deleteLine: (id: string) => void;
  projectId: string;
  catalog: MaterialsCatalogRow[];
};

function BucketRow(props: BucketRowProps) {
  const {
    line,
    progress,
    isOver,
    isExpanded,
    bucketLines,
    editingId,
    editValue,
    setEditValue,
    setEditingId,
    isPending,
    saveEdit,
    startEdit,
    toggleExpand,
    removeBucket,
    addingLineFor,
    setAddingLineFor,
    editingLine,
    setEditingLine,
    deleteLine,
    projectId,
    catalog,
  } = props;

  return (
    <>
      <tr className="border-b last:border-0">
        <td className="px-2 py-2">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => toggleExpand(line.bucket_id)}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        </td>
        <td className="px-3 py-2">
          {line.bucket_name}
          {bucketLines.length > 0 && (
            <span className="ml-2 text-xs text-muted-foreground">
              ({bucketLines.length} line{bucketLines.length === 1 ? '' : 's'})
            </span>
          )}
        </td>
        <td className="px-3 py-2 text-right">
          {editingId === line.bucket_id ? (
            <div className="flex items-center justify-end gap-1">
              <div className="relative flex-1">
                <span className="-translate-y-1/2 absolute top-1/2 left-2 text-muted-foreground text-sm">
                  $
                </span>
                <Input
                  type="number"
                  step="0.01"
                  className="h-7 pl-5 text-right text-sm"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveEdit(line.bucket_id);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  onBlur={() => saveEdit(line.bucket_id)}
                  autoFocus
                />
              </div>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => saveEdit(line.bucket_id)}
                disabled={isPending}
                aria-label="Save"
                title="Save (Enter)"
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                <Check className="size-4" />
              </button>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setEditingId(null)}
                aria-label="Cancel"
                title="Cancel (Esc)"
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="cursor-pointer hover:underline"
              onClick={() => startEdit(line)}
            >
              {formatCurrency(line.estimate_cents)}
            </button>
          )}
        </td>
        <td className="px-3 py-2 text-right">{formatCurrency(line.actual_cents)}</td>
        <td className={cn('px-3 py-2 text-right', isOver && 'font-medium text-red-600')}>
          {formatCurrency(Math.abs(line.remaining_cents))}
          {isOver ? ' over' : ''}
        </td>
        <td className="px-3 py-2">
          <div className="h-1.5 w-full rounded-full bg-gray-200">
            <div
              className={cn(
                'h-full rounded-full',
                isOver ? 'bg-red-500' : progress > 80 ? 'bg-yellow-500' : 'bg-green-500',
              )}
              style={{ width: `${Math.min(progress, 100)}%` }}
            />
          </div>
        </td>
        <td className="px-2 py-2 text-right">
          <Button
            size="xs"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => removeBucket(line.bucket_id)}
          >
            ×
          </Button>
        </td>
      </tr>
      {isExpanded && (
        <tr className="border-b bg-muted/20">
          <td />
          <td colSpan={6} className="px-3 py-3">
            <div className="space-y-2">
              {bucketLines.length === 0 ? (
                <p className="text-xs text-muted-foreground">No line items in this category yet.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="px-2 py-1 text-left font-medium">Label</th>
                      <th className="px-2 py-1 text-right font-medium">Qty</th>
                      <th className="px-2 py-1 text-left font-medium">Unit</th>
                      <th className="px-2 py-1 text-right font-medium">Cost</th>
                      <th className="px-2 py-1 text-right font-medium">Price</th>
                      <th className="px-2 py-1 text-right font-medium">Total</th>
                      <th className="px-2 py-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {bucketLines.map((cl) => (
                      <tr key={cl.id} className="border-t">
                        <td className="px-2 py-1">
                          {cl.label}
                          {cl.notes && (
                            <span className="ml-1 text-muted-foreground">— {cl.notes}</span>
                          )}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">{Number(cl.qty)}</td>
                        <td className="px-2 py-1 text-muted-foreground">{cl.unit}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                          {formatCurrencyCompact(cl.unit_cost_cents)}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {formatCurrencyCompact(cl.unit_price_cents)}
                        </td>
                        <td className="px-2 py-1 text-right font-medium tabular-nums">
                          {formatCurrencyCompact(cl.line_price_cents)}
                        </td>
                        <td className="px-2 py-1 text-right">
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => {
                              setEditingLine(cl);
                              setAddingLineFor(null);
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() => deleteLine(cl.id)}
                          >
                            Del
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {editingLine && editingLine.bucket_id === line.bucket_id ? (
                <CostLineForm
                  projectId={projectId}
                  initial={editingLine}
                  catalog={catalog}
                  defaultBucketId={line.bucket_id}
                  onDone={() => setEditingLine(null)}
                />
              ) : addingLineFor === line.bucket_id ? (
                <CostLineForm
                  projectId={projectId}
                  catalog={catalog}
                  defaultBucketId={line.bucket_id}
                  onDone={() => setAddingLineFor(null)}
                />
              ) : (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    setAddingLineFor(line.bucket_id);
                    setEditingLine(null);
                  }}
                >
                  + Add line to {line.bucket_name}
                </Button>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function AddBucketForm({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [name, setName] = useState('');
  const [section, setSection] = useState('interior');
  const [estimate, setEstimate] = useState('');
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }
    const estimate_cents = Math.round(parseFloat(estimate || '0') * 100);
    startTransition(async () => {
      const result = await addBucketAction({
        project_id: projectId,
        name: name.trim(),
        section,
        estimate_cents,
      });
      if (result.ok) {
        toast.success('Bucket added');
        onDone();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border bg-muted/30 p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <label htmlFor="add-bucket-name" className="mb-1 block text-xs font-medium">
            Name
          </label>
          <Input
            id="add-bucket-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Kitchen"
            required
          />
        </div>
        <div>
          <label htmlFor="add-bucket-section" className="mb-1 block text-xs font-medium">
            Section
          </label>
          <select
            id="add-bucket-section"
            value={section}
            onChange={(e) => setSection(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="interior">interior</option>
            <option value="exterior">exterior</option>
            <option value="general">general</option>
          </select>
        </div>
        <div>
          <label htmlFor="add-bucket-estimate" className="mb-1 block text-xs font-medium">
            Estimate ($)
          </label>
          <Input
            id="add-bucket-estimate"
            type="number"
            step="0.01"
            min="0"
            value={estimate}
            onChange={(e) => setEstimate(e.target.value)}
            placeholder="0.00"
          />
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? 'Adding…' : 'Add category'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
