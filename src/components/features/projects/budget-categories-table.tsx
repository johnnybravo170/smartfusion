'use client';

/**
 * Budget categories table for the project detail page.
 *
 * Inline estimate editing, add/remove categories, expandable rows showing the
 * cost lines associated with each category, and a one-click "generate estimate
 * from categories" button that seeds cost lines from category estimates.
 */

import { ChevronDown, ChevronRight, ChevronUp, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Fragment, useEffect, useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { CostLineActualsInline } from '@/components/features/projects/cost-line-actuals-inline';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { AppliedChangeOrderContribution } from '@/lib/db/queries/change-orders';
import type { CostLineRow } from '@/lib/db/queries/cost-lines';
import type { MaterialsCatalogRow } from '@/lib/db/queries/materials-catalog';
import type { BudgetLine } from '@/lib/db/queries/project-budget-categories';
import { withFrom } from '@/lib/nav/from-link';
import { formatCurrencyCompact } from '@/lib/pricing/calculator';
import { cn } from '@/lib/utils';
import {
  addBudgetCategoryAction,
  moveSectionAction,
  removeBudgetCategoryAction,
  updateBudgetCategoryAction,
} from '@/server/actions/project-budget-categories';
import {
  deleteCostLineAction,
  generateEstimateFromCategoriesAction,
} from '@/server/actions/project-cost-control';
import { CostLineForm } from './cost-line-form';

type BudgetCategoriesTableProps = {
  lines: BudgetLine[];
  projectId: string;
  costLines: CostLineRow[];
  catalog: MaterialsCatalogRow[];
  /** Audit lens — categories touched by applied COs get a chip. */
  coContributionsByCategoryId?: Record<string, AppliedChangeOrderContribution[]>;
  /** Editing/Executing posture (decision 6790ef2b). Editing expands
   * sections by default; Executing collapses them. Defaults to 'editing'
   * so the prop is optional for legacy callers. */
  mode?: 'editing' | 'executing';
  /** Extra buttons rendered in the action row alongside Add category +
   * Generate Estimate. Used by the budget tab to inline Save as template
   * here instead of in a separate row above the table. */
  headerActions?: React.ReactNode;
};

export function BudgetCategoriesTable({
  lines,
  projectId,
  costLines,
  catalog,
  coContributionsByCategoryId = {},
  mode = 'editing',
  headerActions,
}: BudgetCategoriesTableProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editingDescId, setEditingDescId] = useState<string | null>(null);
  const [editDescValue, setEditDescValue] = useState('');
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [editNameValue, setEditNameValue] = useState('');
  // In Executing mode, sections start collapsed (operator is in
  // status-tracking posture; line-level detail is on-demand). In
  // Editing mode the default UX is fully visible — the operator is
  // authoring scope.
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    mode === 'editing' ? new Set(lines.map((l) => l.budget_category_id)) : new Set(),
  );
  const [addingLineFor, setAddingLineFor] = useState<string | null>(null);
  const [editingLine, setEditingLine] = useState<CostLineRow | null>(null);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [isPending, startTransition] = useTransition();
  // Lines that the operator has tapped × on but the 5s undo window
  // hasn't yet expired. Hidden from render; the actual server-side
  // delete fires when the timer elapses (or never, if undo clicks).
  const [pendingDeletes, setPendingDeletes] = useState<Set<string>>(new Set());
  const router = useRouter();
  const searchParams = useSearchParams();

  // Variance tab on Overview deep-links here with `?focus=<category>` so
  // the user lands directly on the category they wanted to edit. Match by
  // budget_category_name (case-insensitive — variance categories arrive lowercase
  // capitalize; category names are operator-typed). Highlight fades after
  // ~2.5s so the table looks normal again on subsequent interactions.
  const focusName = searchParams.get('focus');
  const focusCategoryId = useMemo(() => {
    if (!focusName) return null;
    const needle = focusName.toLowerCase().trim();
    return (
      lines.find((l) => l.budget_category_name.toLowerCase().trim() === needle)
        ?.budget_category_id ?? null
    );
  }, [focusName, lines]);

  const [highlight, setHighlight] = useState(false);
  useEffect(() => {
    if (!focusCategoryId) return;
    setHighlight(true);
    const t = setTimeout(() => setHighlight(false), 2500);
    return () => clearTimeout(t);
  }, [focusCategoryId]);

  const sections = new Map<string, BudgetLine[]>();
  for (const line of lines) {
    const existing = sections.get(line.section) ?? [];
    existing.push(line);
    sections.set(line.section, existing);
  }

  const linesByBudgetCategory = new Map<string, CostLineRow[]>();
  for (const cl of costLines) {
    if (!cl.budget_category_id) continue;
    if (pendingDeletes.has(cl.id)) continue; // optimistically hidden
    const arr = linesByBudgetCategory.get(cl.budget_category_id) ?? [];
    arr.push(cl);
    linesByBudgetCategory.set(cl.budget_category_id, arr);
  }

  function toggleExpand(categoryId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
  }

  function startEdit(line: BudgetLine) {
    setEditingId(line.budget_category_id);
    setEditValue(String(line.estimate_cents / 100));
  }

  function saveEdit(categoryId: string) {
    const cents = Math.round(Number(editValue) * 100);
    if (Number.isNaN(cents) || cents < 0) {
      toast.error('Invalid amount');
      return;
    }
    startTransition(async () => {
      const result = await updateBudgetCategoryAction({
        id: categoryId,
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

  function startEditDesc(line: BudgetLine) {
    setEditingDescId(line.budget_category_id);
    setEditDescValue(line.budget_category_description ?? '');
  }

  function startEditName(line: BudgetLine) {
    setEditingNameId(line.budget_category_id);
    setEditNameValue(line.budget_category_name);
  }

  function saveEditName(categoryId: string, originalName: string) {
    const trimmed = editNameValue.trim();
    if (!trimmed || trimmed === originalName) {
      setEditingNameId(null);
      return;
    }
    startTransition(async () => {
      const result = await updateBudgetCategoryAction({
        id: categoryId,
        project_id: projectId,
        name: trimmed,
      });
      if (result.ok) {
        toast.success('Category renamed');
        setEditingNameId(null);
      } else {
        toast.error(result.error);
      }
    });
  }

  function saveEditDesc(categoryId: string) {
    startTransition(async () => {
      const result = await updateBudgetCategoryAction({
        id: categoryId,
        project_id: projectId,
        description: editDescValue.trim(),
      });
      if (result.ok) {
        toast.success('Description updated');
        setEditingDescId(null);
      } else {
        toast.error(result.error);
      }
    });
  }

  function removeCategory(categoryId: string) {
    startTransition(async () => {
      const result = await removeBudgetCategoryAction({ id: categoryId, project_id: projectId });
      if (result.ok) toast.success('Category removed');
      else toast.error(result.error);
    });
  }

  function deleteLine(id: string) {
    const line = costLines.find((l) => l.id === id);
    if (!line) return;

    // Detail-aware: only confirm when the line has notes or photos
    // worth protecting. Empty / scaffolded lines delete instantly with
    // a 5s undo toast (Sonner action).
    const hasNotes = (line.notes?.trim() ?? '').length > 0;
    const hasPhotos = (line.photo_storage_paths?.length ?? 0) > 0;
    const hasDetail = hasNotes || hasPhotos;

    if (hasDetail) {
      const reasons: string[] = [];
      if (hasNotes) reasons.push('notes');
      if (hasPhotos) reasons.push('photos');
      const summary = reasons.join(' and ');
      if (!confirm(`This line has ${summary}. Delete anyway?`)) return;
      startTransition(async () => {
        await deleteCostLineAction(id, projectId);
      });
      return;
    }

    // No detail → optimistic undo flow. Hide locally, schedule the
    // server delete for 5s out, cancel if Undo is clicked.
    setPendingDeletes((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });

    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      deleteCostLineAction(id, projectId).then((res) => {
        if (!res.ok) {
          toast.error(res.error || "Couldn't delete line.");
          // Restore from server state on failure.
          setPendingDeletes((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          router.refresh();
        }
      });
    }, 5000);

    toast('Line deleted', {
      duration: 5000,
      action: {
        label: 'Undo',
        onClick: () => {
          cancelled = true;
          clearTimeout(timer);
          setPendingDeletes((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        },
      },
    });
  }

  function generateEstimate() {
    startTransition(async () => {
      const res = await generateEstimateFromCategoriesAction({ project_id: projectId });
      if (res.ok) {
        toast.success(`Seeded ${res.count} line${res.count === 1 ? '' : 's'} from categories`);
        router.push(`/projects/${projectId}?tab=estimate`);
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setShowAddCategory((v) => !v)}>
          {showAddCategory ? 'Cancel' : '+ Add category'}
        </Button>
        <Button size="sm" variant="outline" onClick={generateEstimate} disabled={isPending}>
          Generate Estimate
        </Button>
        {headerActions}
      </div>

      {showAddCategory && (
        <AddBudgetCategoryForm
          projectId={projectId}
          existingSections={Array.from(new Set(lines.map((l) => l.section).filter(Boolean)))}
          onDone={() => setShowAddCategory(false)}
        />
      )}

      {Array.from(sections.entries()).map(([section, sectionLines], sectionIdx, sectionArr) => {
        const sectionTotal = sectionLines.reduce((s, l) => s + l.estimate_cents, 0);
        const sectionActual = sectionLines.reduce((s, l) => s + l.actual_cents, 0);
        const sectionCommitted = sectionLines.reduce((s, l) => s + l.committed_cents, 0);
        const isFirstSection = sectionIdx === 0;
        const isLastSection = sectionIdx === sectionArr.length - 1;

        function moveSection(direction: 'up' | 'down') {
          startTransition(async () => {
            const res = await moveSectionAction({
              project_id: projectId,
              section,
              direction,
            });
            if (!res.ok) toast.error(res.error);
          });
        }

        return (
          <div key={section}>
            <div className="mb-2 flex items-center gap-1">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                {section}
              </h3>
              {/* Section reorder controls — only render in Editing mode */}
              {/* (Executing is read-only on structure). Chevrons over a */}
              {/* drag handle: zero added libraries, predictable on touch, */}
              {/* and the surface area matches the rest of the inline */}
              {/* edit affordances on this page. */}
              {mode === 'editing' && sectionArr.length > 1 ? (
                <div className="flex items-center">
                  <button
                    type="button"
                    onClick={() => moveSection('up')}
                    disabled={isFirstSection || isPending}
                    aria-label={`Move ${section} section up`}
                    title="Move section up"
                    className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    <ChevronUp className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveSection('down')}
                    disabled={isLastSection || isPending}
                    aria-label={`Move ${section} section down`}
                    title="Move section down"
                    className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    <ChevronDown className="size-3.5" />
                  </button>
                </div>
              ) : null}
            </div>
            <div className="overflow-x-auto rounded-md border">
              {/* Number columns sized for typical values ($X,XXX) rather */}
              {/* than worst-case ($XXX,XXX.XX). Combined with */}
              {/* formatCurrencyCompact (drops .00 on whole dollars), this */}
              {/* frees width back into the Category column so descriptions */}
              {/* can run longer before clamping. Executing also drops the */}
              {/* trailing actions col (no per-row × in Executing). */}
              <table
                className={`table-fixed text-sm ${mode === 'executing' ? 'w-full min-w-[760px]' : 'w-full'}`}
              >
                <colgroup>
                  <col className="w-7" />
                  {/* Executing mode: leave Category undefined so table-fixed */}
                  {/* hands it ALL the leftover width (rather than fixing it */}
                  {/* at w-56 and proportionally scaling — that left 40-50% of */}
                  {/* description col empty after the 2-line clamp on wide */}
                  {/* viewports). All other cols stay fixed-width so numbers */}
                  {/* don't dance when a description is long. */}
                  <col />
                  <col className="w-28" />
                  {mode === 'executing' ? <col className="w-24" /> : null}
                  {mode === 'executing' ? <col className="w-24" /> : null}
                  {mode === 'executing' ? <col className="w-28" /> : null}
                  {/* Actions col only renders in Editing mode (× to */}
                  {/* remove a category). Executing has no per-row action, */}
                  {/* so the column would be 40px of dead space. */}
                  {mode === 'editing' ? <col className="w-10" /> : null}
                </colgroup>
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-1 py-1.5" />
                    <th className="px-2 py-1.5 text-left font-medium">Category</th>
                    <th className="px-3 py-1.5 text-right font-medium">Estimate</th>
                    {mode === 'executing' ? (
                      <>
                        <th
                          className="px-3 py-1.5 text-right font-medium"
                          title="Realized cost: labour + bills + expenses"
                        >
                          Spent
                        </th>
                        <th
                          className="px-3 py-1.5 text-right font-medium"
                          title="Promised but not yet realized: accepted vendor quotes + active POs"
                        >
                          Committed
                        </th>
                        <th
                          className="px-3 py-1.5 text-right font-medium"
                          title="Estimate − Spent − Committed. Bar shows progress; negative = over budget."
                        >
                          Remaining
                        </th>
                      </>
                    ) : null}
                    {mode === 'editing' ? <th className="px-2 py-1.5" /> : null}
                  </tr>
                </thead>
                <tbody>
                  {sectionLines.map((line) => {
                    // Split "over" into actual vs projected. Spent alone
                    // > estimate is real overage (red). Spent ≤ estimate
                    // but spent+committed > estimate is projection — the
                    // POs/quotes haven't realized yet, so amber, not red.
                    const totalUsed = line.actual_cents + line.committed_cents;
                    const isActuallyOver = line.actual_cents > line.estimate_cents;
                    const isProjectedOver = !isActuallyOver && totalUsed > line.estimate_cents;
                    const isExpanded = expanded.has(line.budget_category_id);
                    const categoryLines = linesByBudgetCategory.get(line.budget_category_id) ?? [];

                    return (
                      <BudgetCategoryRow
                        key={line.budget_category_id}
                        line={line}
                        isActuallyOver={isActuallyOver}
                        isProjectedOver={isProjectedOver}
                        isExpanded={isExpanded}
                        categoryLines={categoryLines}
                        editingId={editingId}
                        editValue={editValue}
                        setEditValue={setEditValue}
                        setEditingId={setEditingId}
                        isPending={isPending}
                        saveEdit={saveEdit}
                        startEdit={startEdit}
                        toggleExpand={toggleExpand}
                        removeCategory={removeCategory}
                        addingLineFor={addingLineFor}
                        setAddingLineFor={setAddingLineFor}
                        editingLine={editingLine}
                        setEditingLine={setEditingLine}
                        deleteLine={deleteLine}
                        projectId={projectId}
                        catalog={catalog}
                        isFocused={line.budget_category_id === focusCategoryId}
                        showHighlight={highlight && line.budget_category_id === focusCategoryId}
                        editingDescId={editingDescId}
                        editDescValue={editDescValue}
                        setEditDescValue={setEditDescValue}
                        setEditingDescId={setEditingDescId}
                        saveEditDesc={saveEditDesc}
                        startEditDesc={startEditDesc}
                        editingNameId={editingNameId}
                        editNameValue={editNameValue}
                        setEditNameValue={setEditNameValue}
                        setEditingNameId={setEditingNameId}
                        saveEditName={saveEditName}
                        startEditName={startEditName}
                        coContributions={coContributionsByCategoryId[line.budget_category_id] ?? []}
                        mode={mode}
                      />
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-muted/30 font-medium">
                    <td />
                    <td className="px-2 py-1.5">
                      {section.charAt(0).toUpperCase() + section.slice(1)} Total
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {formatCurrencyCompact(sectionTotal)}
                    </td>
                    {mode === 'executing' ? (
                      <>
                        <td className="px-3 py-1.5 text-right">
                          {formatCurrencyCompact(sectionActual)}
                        </td>
                        <td className="px-3 py-1.5 text-right text-muted-foreground">
                          {sectionCommitted > 0 ? formatCurrencyCompact(sectionCommitted) : ''}
                        </td>
                        <td
                          className={cn(
                            'px-3 py-1.5 text-right',
                            sectionActual > sectionTotal && 'text-red-600',
                            sectionActual <= sectionTotal &&
                              sectionActual + sectionCommitted > sectionTotal &&
                              'text-amber-600',
                          )}
                        >
                          {formatCurrencyCompact(
                            Math.abs(sectionTotal - sectionActual - sectionCommitted),
                          )}
                          {sectionActual > sectionTotal
                            ? ' over'
                            : sectionActual + sectionCommitted > sectionTotal
                              ? ' projected over'
                              : ''}
                        </td>
                      </>
                    ) : null}
                    {mode === 'editing' ? <td /> : null}
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

/**
 * Multi-segment budget progress bar.
 *
 * Width basis = max(estimate, spent + committed) so the bar always fills
 * its track when the project is at or over budget. Segments left → right:
 *   1. spent within estimate    — solid green
 *   2. spent over estimate      — solid red       (only if actuals blew past)
 *   3. committed within estimate — light green/hatched
 *   4. committed over estimate   — light red      (the "projected over" portion)
 */
function BudgetProgressBar({
  estimateCents,
  spentCents,
  committedCents,
}: {
  estimateCents: number;
  spentCents: number;
  committedCents: number;
}) {
  const totalUsed = spentCents + committedCents;
  const basis = Math.max(estimateCents, totalUsed, 1);

  const spentWithin = Math.min(spentCents, estimateCents);
  const spentOver = Math.max(0, spentCents - estimateCents);
  const remainingBudgetAfterSpent = Math.max(0, estimateCents - spentCents);
  const committedWithin = Math.min(committedCents, remainingBudgetAfterSpent);
  const committedOver = Math.max(0, committedCents - remainingBudgetAfterSpent);

  const pct = (n: number) => `${(n / basis) * 100}%`;

  const tooltip = [
    `Spent ${formatCurrencyCompact(spentCents)}`,
    committedCents > 0 ? `Committed ${formatCurrencyCompact(committedCents)}` : null,
    `Estimate ${formatCurrencyCompact(estimateCents)}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="mt-1 flex h-1 w-full overflow-hidden rounded-full bg-gray-200" title={tooltip}>
      {spentWithin > 0 ? (
        <div className="bg-green-500" style={{ width: pct(spentWithin) }} />
      ) : null}
      {spentOver > 0 ? <div className="bg-red-500" style={{ width: pct(spentOver) }} /> : null}
      {committedWithin > 0 ? (
        <div className="bg-green-300" style={{ width: pct(committedWithin) }} />
      ) : null}
      {committedOver > 0 ? (
        <div className="bg-red-300" style={{ width: pct(committedOver) }} />
      ) : null}
    </div>
  );
}

type BudgetCategoryRowProps = {
  line: BudgetLine;
  isActuallyOver: boolean;
  isProjectedOver: boolean;
  isExpanded: boolean;
  categoryLines: CostLineRow[];
  editingId: string | null;
  editValue: string;
  setEditValue: (v: string) => void;
  setEditingId: (v: string | null) => void;
  isPending: boolean;
  saveEdit: (id: string) => void;
  startEdit: (line: BudgetLine) => void;
  toggleExpand: (id: string) => void;
  removeCategory: (id: string) => void;
  addingLineFor: string | null;
  setAddingLineFor: (v: string | null) => void;
  editingLine: CostLineRow | null;
  setEditingLine: (v: CostLineRow | null) => void;
  deleteLine: (id: string) => void;
  projectId: string;
  catalog: MaterialsCatalogRow[];
  isFocused: boolean;
  showHighlight: boolean;
  editingDescId: string | null;
  editDescValue: string;
  setEditDescValue: (v: string) => void;
  setEditingDescId: (v: string | null) => void;
  saveEditDesc: (id: string) => void;
  startEditDesc: (line: BudgetLine) => void;
  editingNameId: string | null;
  editNameValue: string;
  setEditNameValue: (v: string) => void;
  setEditingNameId: (v: string | null) => void;
  saveEditName: (id: string, originalName: string) => void;
  startEditName: (line: BudgetLine) => void;
  coContributions: AppliedChangeOrderContribution[];
  mode: 'editing' | 'executing';
};

function BudgetCategoryRow(props: BudgetCategoryRowProps) {
  const {
    line,
    isActuallyOver,
    isProjectedOver,
    isExpanded,
    categoryLines,
    editingId,
    editValue,
    setEditValue,
    setEditingId,
    isPending,
    saveEdit,
    startEdit,
    toggleExpand,
    removeCategory,
    addingLineFor,
    setAddingLineFor,
    editingLine,
    setEditingLine,
    deleteLine,
    projectId,
    catalog,
    isFocused,
    showHighlight,
    editingDescId,
    editDescValue,
    setEditDescValue,
    setEditingDescId,
    saveEditDesc,
    startEditDesc,
    editingNameId,
    editNameValue,
    setEditNameValue,
    setEditingNameId,
    saveEditName,
    startEditName,
    coContributions,
    mode,
  } = props;
  // Distinct CO chip per CO (a CO may have multiple lines in this category;
  // we still want one chip per CO).
  const coChips = Array.from(new Map(coContributions.map((c) => [c.co_id, c])).values());

  // Per-line "see spend" expansion. Only used in Executing mode —
  // Editing-mode operators are authoring, not tracking. State is
  // local to the category row so closing/reopening the category retains
  // which lines were expanded for the current session.
  const [expandedLineIds, setExpandedLineIds] = useState<Set<string>>(new Set());
  function toggleLineSpend(id: string) {
    setExpandedLineIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Callback ref — fires once when the focused row mounts; scroll into
  // view smoothly so the user lands on it without scrolling manually.
  const focusRef = (node: HTMLTableRowElement | null) => {
    if (node && isFocused) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  return (
    <>
      <tr
        ref={isFocused ? focusRef : undefined}
        className={cn(
          'border-b transition-colors last:border-0',
          showHighlight && 'bg-primary/10 ring-2 ring-primary/40 ring-inset',
        )}
      >
        <td className="px-1 py-1.5">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => toggleExpand(line.budget_category_id)}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        </td>
        <td className="px-2 py-1.5">
          <div className="group flex flex-wrap items-center gap-1.5">
            {editingNameId === line.budget_category_id ? (
              // Keyboard contract per PATTERNS.md §4: Enter saves, Escape
              // cancels, blur saves. No save/cancel chrome — would just
              // duplicate what the keyboard already does.
              <Input
                className="h-7 w-auto min-w-[200px] text-sm"
                value={editNameValue}
                onChange={(e) => setEditNameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter')
                    saveEditName(line.budget_category_id, line.budget_category_name);
                  if (e.key === 'Escape') setEditingNameId(null);
                }}
                onBlur={() => saveEditName(line.budget_category_id, line.budget_category_name)}
                autoFocus
                disabled={isPending}
              />
            ) : (
              <>
                {/* Click anywhere on the name (or the "X lines" hint) to */}
                {/* toggle the row's expanded detail. Pencil on hover */}
                {/* opens the rename input — keeps the chevron as a */}
                {/* redundant affordance and matches the project-name */}
                {/* editor pattern from PATTERNS.md §4. */}
                <button
                  type="button"
                  onClick={() => toggleExpand(line.budget_category_id)}
                  className="inline-flex items-center gap-1.5 text-left hover:text-foreground"
                  aria-expanded={isExpanded}
                >
                  <span>{line.budget_category_name}</span>
                  {categoryLines.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {categoryLines.length} line{categoryLines.length === 1 ? '' : 's'}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => startEditName(line)}
                  className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
                  aria-label="Rename category"
                >
                  <Pencil className="size-3" />
                </button>
              </>
            )}
            {coChips.map((c) => (
              <a
                key={c.co_id}
                href={withFrom(
                  `/projects/${projectId}/change-orders/${c.co_id}`,
                  `/projects/${projectId}?tab=budget`,
                  'Budget',
                )}
                title={`Touched by CO: ${c.co_title}`}
                className="inline-flex items-center rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-blue-800 hover:bg-blue-200"
              >
                CO {c.co_short_id}
              </a>
            ))}
          </div>
          {editingDescId === line.budget_category_id ? (
            // Keyboard contract per PATTERNS.md §4.
            <div className="mt-1">
              <Textarea
                className="min-h-[4.5rem] resize-y text-xs"
                rows={3}
                value={editDescValue}
                onChange={(e) => setEditDescValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    saveEditDesc(line.budget_category_id);
                  }
                  if (e.key === 'Escape') setEditingDescId(null);
                }}
                onBlur={() => saveEditDesc(line.budget_category_id)}
                placeholder="Description (shown on estimate). Enter to save, Shift+Enter for new line."
                autoFocus
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => startEditDesc(line)}
              title={line.budget_category_description ?? undefined}
              className="mt-0.5 block w-full text-left text-xs text-muted-foreground hover:text-foreground"
            >
              {line.budget_category_description ? (
                // Clamp to 2 lines so each row is predictable height.
                // Full text available via title tooltip on hover, or by
                // clicking to edit.
                <span className="line-clamp-2 whitespace-pre-wrap">
                  {line.budget_category_description}
                </span>
              ) : (
                <span className="italic opacity-60">+ Add description</span>
              )}
            </button>
          )}
        </td>
        <td className="px-3 py-1.5 text-right">
          {editingId === line.budget_category_id ? (
            // Keyboard contract per PATTERNS.md §4.
            <div className="relative z-10 flex items-center justify-end bg-background">
              <span className="-translate-y-1/2 absolute top-1/2 left-2 z-10 text-muted-foreground text-sm">
                $
              </span>
              <Input
                type="number"
                step="0.01"
                className="h-7 w-[120px] bg-background pl-5 text-right text-sm"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveEdit(line.budget_category_id);
                  if (e.key === 'Escape') setEditingId(null);
                }}
                onBlur={() => saveEdit(line.budget_category_id)}
                autoFocus
              />
            </div>
          ) : // When the bucket has priced cost lines, the estimate IS the
          // sum of those lines (single source of truth — see
          // project-budget-categories.ts). Inline edit only makes sense
          // for envelope-only buckets; otherwise the operator edits
          // line prices directly to move this number.
          line.lines_total_cents > 0 ? (
            <span
              className="text-muted-foreground"
              title={`Sum of ${categoryLines.length} cost line${categoryLines.length === 1 ? '' : 's'}. Edit a line below to change this number.`}
            >
              {formatCurrencyCompact(line.estimate_cents)}
            </span>
          ) : (
            <button
              type="button"
              className="cursor-pointer hover:underline"
              onClick={() => startEdit(line)}
              title="Click to set an envelope. Once you add priced lines, the line sum takes over."
            >
              {formatCurrencyCompact(line.estimate_cents)}
            </button>
          )}
        </td>
        {mode === 'executing' ? (
          <>
            <td className="px-3 py-1.5 text-right">{formatCurrencyCompact(line.actual_cents)}</td>
            <td className="px-3 py-1.5 text-right text-muted-foreground">
              {line.committed_cents > 0 ? formatCurrencyCompact(line.committed_cents) : ''}
            </td>
            {/* Remaining + progress merged: dollar amount on top, thin */}
            {/* bar underneath. The bar is multi-segment so the operator */}
            {/* can tell at a glance how much of the row is real spend */}
            {/* vs. committed-but-not-yet-realized. Without the split a */}
            {/* row reads as "blown the budget" when in fact actuals are */}
            {/* under and the overage is purely projected from POs. */}
            <td
              className={cn(
                'px-3 py-1.5 text-right',
                isActuallyOver && 'font-medium text-red-600',
                isProjectedOver && 'font-medium text-amber-600',
              )}
            >
              <div>
                {formatCurrencyCompact(Math.abs(line.remaining_cents))}
                {isActuallyOver ? ' over' : isProjectedOver ? ' projected over' : ''}
              </div>
              <BudgetProgressBar
                estimateCents={line.estimate_cents}
                spentCents={line.actual_cents}
                committedCents={line.committed_cents}
              />
            </td>
          </>
        ) : null}
        {/* Remove-category is an authoring action — only available in */}
        {/* Editing mode. In Executing mode the entire actions column */}
        {/* doesn't render (would be 40px of dead space on every row). */}
        {mode === 'editing' ? (
          <td className="px-2 py-1.5 text-right">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="xs"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  aria-label={`Remove ${line.budget_category_name}`}
                >
                  ×
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove {line.budget_category_name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {categoryLines.length > 0
                      ? `This category has ${categoryLines.length} cost line${categoryLines.length === 1 ? '' : 's'}. They will be orphaned (kept on the project but unlinked from any category) so no spend history is lost.`
                      : 'This category has no cost lines.'}{' '}
                    If any time entries or expenses are linked to this category, the removal will be
                    blocked — reassign those first.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => removeCategory(line.budget_category_id)}
                    disabled={isPending}
                    className="bg-destructive/10 text-destructive hover:bg-destructive/20"
                  >
                    Remove category
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </td>
        ) : null}
      </tr>
      {isExpanded && (
        // Stronger bg + a left accent stripe that visually attaches the
        // expanded detail to its parent category row above. Eyes can follow
        // "this content belongs to that category" without re-reading.
        <tr className="border-b bg-muted/40">
          <td />
          <td
            colSpan={mode === 'executing' ? 5 : 2}
            className="border-l-2 border-primary/40 px-3 py-3"
          >
            <div className="space-y-3">
              {/* Actuals breakdown by source — synthesized from */}
              {/* time_entries, expenses, project_bills. Slim inline */}
              {/* strip rather than a panel; each chunk deep-links to */}
              {/* the tab where the underlying records live. */}
              {line.labor_cents > 0 || line.bills_cents > 0 || line.expense_cents > 0 ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-blue-200 bg-blue-50/80 px-3 py-1.5 text-xs dark:border-blue-900/60 dark:bg-blue-950/30">
                  <span className="font-medium uppercase tracking-wide text-[10px] text-muted-foreground">
                    Spent
                  </span>
                  {line.labor_cents > 0 ? (
                    <Link
                      href={`/projects/${projectId}?tab=time&focus=${line.budget_category_id}`}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      Labour{' '}
                      <span className="font-medium tabular-nums text-foreground">
                        {formatCurrencyCompact(line.labor_cents)}
                      </span>
                    </Link>
                  ) : null}
                  {line.bills_cents > 0 ? (
                    <Link
                      href={`/projects/${projectId}?tab=costs&focus=${line.budget_category_id}`}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      Bills{' '}
                      <span className="font-medium tabular-nums text-foreground">
                        {formatCurrencyCompact(line.bills_cents)}
                      </span>
                    </Link>
                  ) : null}
                  {line.expense_cents > 0 ? (
                    <Link
                      href={`/projects/${projectId}?tab=costs&focus=${line.budget_category_id}`}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      Expenses{' '}
                      <span className="font-medium tabular-nums text-foreground">
                        {formatCurrencyCompact(line.expense_cents)}
                      </span>
                    </Link>
                  ) : null}
                </div>
              ) : null}

              {categoryLines.length === 0 ? (
                <p className="text-xs text-muted-foreground">No line items in this category yet.</p>
              ) : (
                // Line items have 7 cols (Label + 5 numeric + actions) which
                // do not fit a 390px mobile viewport — Editing mode collapsed
                // view fits natively, but when expanded the cell would crush
                // the Label col and clip Total. Local overflow-x-auto + a
                // table-level min-w keeps the collapsed table tidy and lets
                // only this sub-table scroll horizontally when expanded.
                <div className="overflow-x-auto rounded-md border bg-background">
                  <table className="w-full min-w-[640px] table-fixed text-xs">
                    <colgroup>
                      <col />
                      <col className="w-12" />
                      <col className="w-14" />
                      <col className="w-20" />
                      <col className="w-20" />
                      <col className="w-24" />
                      {/* Actions: Edit + Delete at size="xs" need ~110px */}
                      {/* + gap. w-24 was overflowing into the Total col. */}
                      <col className="w-32" />
                    </colgroup>
                    <thead>
                      <tr className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                        <th className="px-2 py-1.5 text-left font-medium">Label</th>
                        <th className="px-2 py-1.5 text-right font-medium">Qty</th>
                        <th className="px-2 py-1.5 text-left font-medium">Unit</th>
                        <th className="px-2 py-1.5 text-right font-medium">Cost</th>
                        <th className="px-2 py-1.5 text-right font-medium">Price</th>
                        <th className="px-2 py-1.5 text-right font-medium">Total</th>
                        <th className="px-2 py-1.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {categoryLines.map((cl) => {
                        const isLineExpanded = expandedLineIds.has(cl.id);
                        return (
                          <Fragment key={cl.id}>
                            <tr className="border-t hover:bg-muted/40">
                              <td className="px-2 py-1.5 align-top">
                                {/* Label on its own line; description */}
                                {/* drops to muted text-xs underneath */}
                                {/* (clamped to 2 lines, full text on */}
                                {/* hover via title). Executing mode: */}
                                {/* the label toggles the inline spend */}
                                {/* breakdown for this specific line. */}
                                <div className="flex flex-col gap-0.5">
                                  {mode === 'executing' ? (
                                    <button
                                      type="button"
                                      onClick={() => toggleLineSpend(cl.id)}
                                      className="inline-flex items-start gap-1 text-left font-medium hover:text-foreground"
                                      aria-expanded={isLineExpanded}
                                      title={
                                        isLineExpanded
                                          ? 'Hide spend on this line'
                                          : 'See spend on this line'
                                      }
                                    >
                                      {isLineExpanded ? (
                                        <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                                      ) : (
                                        <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                                      )}
                                      <span>{cl.label}</span>
                                    </button>
                                  ) : (
                                    <span className="font-medium">{cl.label}</span>
                                  )}
                                  {cl.notes ? (
                                    <span
                                      className="line-clamp-2 text-[11px] text-muted-foreground"
                                      title={cl.notes}
                                    >
                                      {cl.notes}
                                    </span>
                                  ) : null}
                                </div>
                              </td>
                              <td className="px-2 py-1.5 text-right align-top tabular-nums">
                                {Number(cl.qty)}
                              </td>
                              <td className="px-2 py-1.5 align-top text-muted-foreground">
                                {cl.unit}
                              </td>
                              <td className="px-2 py-1.5 text-right align-top tabular-nums text-muted-foreground">
                                {formatCurrencyCompact(cl.unit_cost_cents)}
                              </td>
                              <td className="px-2 py-1.5 text-right align-top tabular-nums">
                                {formatCurrencyCompact(cl.unit_price_cents)}
                              </td>
                              <td className="px-2 py-1.5 text-right align-top font-medium tabular-nums">
                                {formatCurrencyCompact(cl.line_price_cents)}
                              </td>
                              {/* Plain text-link buttons (not Button size="xs") */}
                              {/* so the baseline lines up with the numeric */}
                              {/* cells in the same row. xs Button adds */}
                              {/* height + padding that visibly drifts off */}
                              {/* the text baseline of $X,XXX cells. */}
                              <td className="px-2 py-1.5 text-right align-top tabular-nums">
                                <div className="inline-flex items-center gap-3">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingLine(cl);
                                      setAddingLineFor(null);
                                    }}
                                    className="hover:underline"
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => deleteLine(cl.id)}
                                    className="text-destructive hover:underline"
                                  >
                                    Delete
                                  </button>
                                </div>
                              </td>
                            </tr>
                            {mode === 'executing' && isLineExpanded ? (
                              <tr>
                                <td colSpan={7} className="bg-muted/30 px-3 py-2">
                                  <CostLineActualsInline
                                    projectId={projectId}
                                    costLineId={cl.id}
                                    costLineLabel={cl.label}
                                  />
                                </td>
                              </tr>
                            ) : null}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {editingLine && editingLine.budget_category_id === line.budget_category_id ? (
                <CostLineForm
                  projectId={projectId}
                  initial={editingLine}
                  catalog={catalog}
                  defaultCategoryId={line.budget_category_id}
                  onDone={() => setEditingLine(null)}
                />
              ) : addingLineFor === line.budget_category_id ? (
                <CostLineForm
                  projectId={projectId}
                  catalog={catalog}
                  defaultCategoryId={line.budget_category_id}
                  onDone={() => setAddingLineFor(null)}
                />
              ) : (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    setAddingLineFor(line.budget_category_id);
                    setEditingLine(null);
                  }}
                >
                  + Add line to {line.budget_category_name}
                </Button>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function AddBudgetCategoryForm({
  projectId,
  existingSections,
  onDone,
}: {
  projectId: string;
  /** Sections already in use on this project — drives the datalist
   * autocomplete. Free-text per migration 0072; operator can type a
   * brand-new section name and it just becomes one. */
  existingSections: string[];
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [section, setSection] = useState(existingSections[0] ?? 'interior');
  const [estimate, setEstimate] = useState('');
  const [description, setDescription] = useState('');
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }
    const estimate_cents = Math.round(parseFloat(estimate || '0') * 100);
    startTransition(async () => {
      const result = await addBudgetCategoryAction({
        project_id: projectId,
        name: name.trim(),
        section,
        estimate_cents,
        description: description.trim() || undefined,
      });
      if (result.ok) {
        toast.success('Category added');
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
          <label htmlFor="add-category-name" className="mb-1 block text-xs font-medium">
            Name
          </label>
          <Input
            id="add-category-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Kitchen"
            required
          />
        </div>
        <div>
          <label htmlFor="add-category-section" className="mb-1 block text-xs font-medium">
            Section
          </label>
          <Input
            id="add-category-section"
            list="add-category-section-options"
            value={section}
            onChange={(e) => setSection(e.target.value)}
            placeholder="e.g. Kitchen, Basement, Exterior"
          />
          <datalist id="add-category-section-options">
            {/* Existing sections + the legacy three so operators have a
                starting point if they're seeding a fresh project. */}
            {Array.from(new Set([...existingSections, 'interior', 'exterior', 'general']))
              .filter(Boolean)
              .map((s) => (
                <option key={s} value={s} />
              ))}
          </datalist>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Type any section name. New ones become headers automatically.
          </p>
        </div>
        <div>
          <label htmlFor="add-category-estimate" className="mb-1 block text-xs font-medium">
            Estimate ($)
          </label>
          <Input
            id="add-category-estimate"
            type="number"
            step="0.01"
            min="0"
            value={estimate}
            onChange={(e) => setEstimate(e.target.value)}
            placeholder="0.00"
          />
        </div>
        <div className="sm:col-span-4">
          <label htmlFor="add-category-description" className="mb-1 block text-xs font-medium">
            Description{' '}
            <span className="text-muted-foreground">(optional — shown on estimate)</span>
          </label>
          <Textarea
            id="add-category-description"
            rows={3}
            className="min-h-[4.5rem] resize-y"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Demo existing tile, prep subfloor, install LVP"
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
