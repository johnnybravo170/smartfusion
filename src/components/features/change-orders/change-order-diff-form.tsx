'use client';

/**
 * Phase 1 line-diff change-order editor.
 *
 * Renders the project's existing cost lines grouped by budget category +
 * section. Each line is editable in place (qty / unit_price) with a live
 * delta badge. Operator can also strikethrough-remove a line or "+ Add
 * line" inside any category. The total cost impact is auto-derived from
 * the sum of deltas.
 *
 * Phase 1 deliberately:
 *   • does NOT auto-apply the diff to project_cost_lines on approval —
 *     persists the staged diff only. Approval still happens, but the
 *     underlying estimate stays untouched until the apply-on-approval
 *     phase ships.
 *   • does NOT prompt when editing an approved estimate — that guard
 *     is a separate piece (kanban 707d5395 covers the full flow).
 *
 * Reachable today via `?v2=1` on the new-CO page; existing form stays
 * default until this is verified end-to-end.
 */

import { ChevronDown, ChevronRight, Plus, RotateCcw, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import type { CostLineRow } from '@/lib/db/queries/cost-lines';
import type { BudgetCategorySummary } from '@/lib/db/queries/projects';
import { formatCurrency } from '@/lib/pricing/calculator';
import { cn } from '@/lib/utils';
import {
  createChangeOrderV2Action,
  updateChangeOrderV2Action,
} from '@/server/actions/change-orders';
import { addBudgetCategoryAction } from '@/server/actions/project-budget-categories';

type LineEdit = {
  qty?: string;
  unit_price_dollars?: string;
  notes?: string;
};

type AddedLine = {
  tempId: string;
  budget_category_id: string;
  label: string;
  qty: string;
  unit: string;
  unit_price_dollars: string;
  notes: string;
};

/** Pre-filled state for edit mode — reverse-mapped from a draft CO + its
 * change_order_lines by the parent page. The parent owns the reconstruction
 * so the form stays presentational. */
export type ChangeOrderFormInitialState = {
  title: string;
  description: string;
  reason: string;
  timelineDays: string;
  /** Pct as a string (e.g. "12") or null when no override is set. */
  mgmtFeePct: string | null;
  mgmtFeeReason: string;
  editsById: Record<string, LineEdit>;
  removedIds: string[];
  added: AddedLine[];
  notesByCategory: Record<string, string>;
  envelopeEdits: Record<string, string>;
};

export type ChangeOrderFormMode =
  | { kind: 'create' }
  | { kind: 'edit'; changeOrderId: string; initialState: ChangeOrderFormInitialState };

export function ChangeOrderDiffForm({
  projectId,
  budgetCategories,
  existingLines,
  defaultManagementFeeRate,
  mode = { kind: 'create' },
}: {
  projectId: string;
  budgetCategories: BudgetCategorySummary[];
  existingLines: CostLineRow[];
  /** Project-level mgmt fee rate (0..0.5). Pre-fills the per-CO override
   *  field. The customer-visible fee on this CO is computed from this
   *  rate × cost_impact unless the operator overrides it. */
  defaultManagementFeeRate: number;
  mode?: ChangeOrderFormMode;
}) {
  const isEdit = mode.kind === 'edit';
  const initial = mode.kind === 'edit' ? mode.initialState : null;

  // Local copy of the project's categories so newly-created ones from this CO
  // form show up immediately without a full page refresh. Persisted server-
  // side at the moment of creation (not staged), per the design call to
  // keep abandoned drafts harmless.
  const [localCategories, setLocalCategories] = useState(budgetCategories);
  const [creatingCategory, setCreatingCategory] = useState<string | null>(null); // section name being added to, or '__new_section__'
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newSectionName, setNewSectionName] = useState('');
  const [creatingPending, setCreatingPending] = useState(false);

  async function commitNewCategory(targetSection: string) {
    const name = newCategoryName.trim();
    if (!name) return;
    setCreatingPending(true);
    const res = await addBudgetCategoryAction({
      project_id: projectId,
      name,
      section: targetSection,
      estimate_cents: 0,
    });
    setCreatingPending(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    // Optimistically push the new category into local state so the form
    // re-renders with it immediately. display_order from server is what we
    // approximate here — fine for client-side ordering.
    setLocalCategories((prev) => [
      ...prev,
      {
        id: res.id,
        name,
        section: targetSection,
        description: null,
        estimate_cents: 0,
        display_order: prev.length,
        is_visible_in_report: true,
      },
    ]);
    setNewCategoryName('');
    setCreatingCategory(null);
    // Auto-open the new category so the operator can add a line right away.
    setForceOpenCategories((prev) => new Set(prev).add(res.id));
  }

  async function commitNewSection() {
    const sectionName = newSectionName.trim();
    const name = newCategoryName.trim();
    if (!sectionName || !name) return;
    setCreatingPending(true);
    const res = await addBudgetCategoryAction({
      project_id: projectId,
      name,
      section: sectionName,
      estimate_cents: 0,
    });
    setCreatingPending(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setLocalCategories((prev) => [
      ...prev,
      {
        id: res.id,
        name,
        section: sectionName,
        description: null,
        estimate_cents: 0,
        display_order: prev.length,
        is_visible_in_report: true,
      },
    ]);
    setNewCategoryName('');
    setNewSectionName('');
    setCreatingCategory(null);
    setForceOpenCategories((prev) => new Set(prev).add(res.id));
  }
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [reason, setReason] = useState(initial?.reason ?? '');
  const [timelineDays, setTimelineDays] = useState(initial?.timelineDays ?? '0');

  // Per-CO management fee. Pre-filled with the project default; operator
  // can scale back as the project grows. Reason is required when the
  // value differs from the default.
  const defaultRatePct = (defaultManagementFeeRate * 100).toFixed(2).replace(/\.?0+$/, '');
  const [mgmtFeePct, setMgmtFeePct] = useState(initial?.mgmtFeePct ?? defaultRatePct);
  const [mgmtFeeReason, setMgmtFeeReason] = useState(initial?.mgmtFeeReason ?? '');
  const mgmtFeeRateNum = parseFloat(mgmtFeePct || '0') / 100;
  const mgmtFeeChanged = Math.abs(mgmtFeeRateNum - defaultManagementFeeRate) > 0.00001;

  const [editsById, setEditsById] = useState<Record<string, LineEdit>>(initial?.editsById ?? {});
  const [removedIds, setRemovedIds] = useState<Set<string>>(
    () => new Set(initial?.removedIds ?? []),
  );
  const [added, setAdded] = useState<AddedLine[]>(initial?.added ?? []);
  // Per-category narrative notes — surfaces under each affected category.
  const [notesByCategory, setNotesByCategory] = useState<Record<string, string>>(
    initial?.notesByCategory ?? {},
  );
  // Envelope amount edits per category (string for the input; converted to
  // cents in buildDiff). Empty string = not edited. Tracked as
  // 'modify_envelope' diff entries.
  const [envelopeEdits, setEnvelopeEdits] = useState<Record<string, string>>(
    initial?.envelopeEdits ?? {},
  );
  // Manual collapse override per category. Categories with no lines / no
  // edits / no note auto-collapse; clicking the chevron forces them open
  // (so the operator can add a line or note). Categories with anything
  // active stay forced open.
  const [forceOpenCategories, setForceOpenCategories] = useState<Set<string>>(new Set());

  // Group lines by budget_category_id, keyed for stable rendering.
  const linesByCategory = useMemo(() => {
    const map = new Map<string | null, CostLineRow[]>();
    for (const l of existingLines) {
      const key = l.budget_category_id ?? null;
      const arr = map.get(key) ?? [];
      arr.push(l);
      map.set(key, arr);
    }
    return map;
  }, [existingLines]);

  // Sections come from localCategories; group categories under sections.
  const categoriesBySection = useMemo(() => {
    const map = new Map<string, BudgetCategorySummary[]>();
    for (const c of localCategories) {
      const arr = map.get(c.section) ?? [];
      arr.push(c);
      map.set(c.section, arr);
    }
    return map;
  }, [localCategories]);

  // Compute total delta across every modification.
  const totalDelta = useMemo(() => {
    let total = 0;
    // Modifications: (new qty * new price) - (old qty * old price)
    for (const line of existingLines) {
      if (removedIds.has(line.id)) {
        total -= line.line_price_cents;
        continue;
      }
      const edit = editsById[line.id];
      if (!edit) continue;
      const newQty = edit.qty !== undefined ? Number(edit.qty) : Number(line.qty);
      const newUnitPriceCents =
        edit.unit_price_dollars !== undefined
          ? Math.round(Number(edit.unit_price_dollars) * 100)
          : line.unit_price_cents;
      if (Number.isNaN(newQty) || Number.isNaN(newUnitPriceCents)) continue;
      const newPrice = Math.round(newQty * newUnitPriceCents);
      total += newPrice - line.line_price_cents;
    }
    // Added lines
    for (const a of added) {
      const qty = Number(a.qty);
      const unitPriceCents = Math.round(Number(a.unit_price_dollars) * 100);
      if (Number.isNaN(qty) || Number.isNaN(unitPriceCents)) continue;
      total += Math.round(qty * unitPriceCents);
    }
    // Envelope edits: (new envelope - old envelope) when category has no
    // line-level diffs (otherwise the line edits cover the cost impact).
    // Skip envelope delta when the category has any line edits to avoid
    // double-counting — the operator chose to express the change via
    // lines instead.
    for (const cat of localCategories) {
      const newRaw = envelopeEdits[cat.id];
      if (newRaw === undefined || newRaw === '') continue;
      const newCents = Math.round(Number(newRaw) * 100);
      if (Number.isNaN(newCents)) continue;
      const linesForCat = existingLines.filter((l) => l.budget_category_id === cat.id);
      const linesEdited = linesForCat.some(
        (l) => removedIds.has(l.id) || editsById[l.id] !== undefined,
      );
      const addedToCat = added.some((a) => a.budget_category_id === cat.id);
      if (linesEdited || addedToCat) continue;
      total += newCents - cat.estimate_cents;
    }
    return total;
  }, [editsById, removedIds, added, envelopeEdits, existingLines, localCategories]);

  function setEdit(lineId: string, patch: Partial<LineEdit>) {
    setEditsById((prev) => ({
      ...prev,
      [lineId]: { ...prev[lineId], ...patch },
    }));
  }

  function clearEdit(lineId: string) {
    setEditsById((prev) => {
      const next = { ...prev };
      delete next[lineId];
      return next;
    });
  }

  function toggleRemove(lineId: string) {
    setRemovedIds((prev) => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  }

  function addLine(budgetCategoryId: string) {
    setAdded((prev) => [
      ...prev,
      {
        tempId: crypto.randomUUID(),
        budget_category_id: budgetCategoryId,
        label: '',
        qty: '1',
        unit: 'item',
        unit_price_dollars: '',
        notes: '',
      },
    ]);
  }

  function setAdded_(tempId: string, patch: Partial<AddedLine>) {
    setAdded((prev) => prev.map((a) => (a.tempId === tempId ? { ...a, ...patch } : a)));
  }

  function removeAdded(tempId: string) {
    setAdded((prev) => prev.filter((a) => a.tempId !== tempId));
  }

  function buildDiff() {
    const diff: Array<{
      action: 'modify' | 'remove' | 'add' | 'modify_envelope';
      original_line_id?: string;
      budget_category_id?: string;
      category?: string;
      label?: string;
      qty?: number;
      unit?: string;
      unit_cost_cents?: number;
      unit_price_cents?: number;
      line_cost_cents?: number;
      line_price_cents?: number;
      notes?: string;
      before_snapshot?: Record<string, unknown>;
    }> = [];

    for (const line of existingLines) {
      if (removedIds.has(line.id)) {
        const edit = editsById[line.id];
        diff.push({
          action: 'remove',
          original_line_id: line.id,
          notes: edit?.notes?.trim() || undefined,
          before_snapshot: line as unknown as Record<string, unknown>,
        });
        continue;
      }
      const edit = editsById[line.id];
      if (!edit) continue;
      const newQty = edit.qty !== undefined ? Number(edit.qty) : Number(line.qty);
      const newUnitPriceCents =
        edit.unit_price_dollars !== undefined
          ? Math.round(Number(edit.unit_price_dollars) * 100)
          : line.unit_price_cents;
      if (Number.isNaN(newQty) || Number.isNaN(newUnitPriceCents)) continue;
      const noteText = edit.notes?.trim() || undefined;
      // No-op edits (typed back to original) with no note: skip.
      if (newQty === Number(line.qty) && newUnitPriceCents === line.unit_price_cents && !noteText)
        continue;
      const newPrice = Math.round(newQty * newUnitPriceCents);
      const newCost = Math.round(newQty * line.unit_cost_cents);
      diff.push({
        action: 'modify',
        original_line_id: line.id,
        budget_category_id: line.budget_category_id ?? undefined,
        category: line.category,
        label: line.label,
        qty: newQty,
        unit: line.unit,
        unit_cost_cents: line.unit_cost_cents,
        unit_price_cents: newUnitPriceCents,
        line_cost_cents: newCost,
        line_price_cents: newPrice,
        notes: noteText,
        before_snapshot: line as unknown as Record<string, unknown>,
      });
    }

    for (const a of added) {
      const qty = Number(a.qty);
      const unitPriceCents = Math.round(Number(a.unit_price_dollars) * 100);
      if (Number.isNaN(qty) || Number.isNaN(unitPriceCents)) continue;
      if (!a.label.trim()) continue;
      diff.push({
        action: 'add',
        budget_category_id: a.budget_category_id,
        category: 'material',
        label: a.label.trim(),
        qty,
        unit: a.unit,
        unit_cost_cents: 0,
        unit_price_cents: unitPriceCents,
        line_cost_cents: 0,
        line_price_cents: Math.round(qty * unitPriceCents),
        notes: a.notes.trim() || undefined,
      });
    }

    // Envelope-level diffs (modify_envelope). Only emit when the
    // category has no line edits — otherwise the lines already
    // represent the change.
    for (const cat of localCategories) {
      const newRaw = envelopeEdits[cat.id];
      if (newRaw === undefined || newRaw === '') continue;
      const newCents = Math.round(Number(newRaw) * 100);
      if (Number.isNaN(newCents) || newCents === cat.estimate_cents) continue;
      const linesForCat = existingLines.filter((l) => l.budget_category_id === cat.id);
      const linesEdited = linesForCat.some(
        (l) => removedIds.has(l.id) || editsById[l.id] !== undefined,
      );
      const addedToCat = added.some((a) => a.budget_category_id === cat.id);
      if (linesEdited || addedToCat) continue;
      diff.push({
        action: 'modify_envelope',
        budget_category_id: cat.id,
        label: cat.name,
        line_price_cents: newCents,
        notes: notesByCategory[cat.id]?.trim() || undefined,
        before_snapshot: {
          kind: 'envelope',
          estimate_cents: cat.estimate_cents,
        },
      });
    }

    return diff;
  }

  async function handleSubmit(goToPreview: boolean) {
    setLoading(true);
    setError(null);
    const diff = buildDiff();
    if (diff.length === 0) {
      setError('No changes to save — edit a line, remove one, or add a new one.');
      setLoading(false);
      return;
    }

    if (mgmtFeeChanged && mgmtFeeReason.trim().length === 0) {
      setError('Please add a reason for the management fee adjustment so the change is auditable.');
      setLoading(false);
      return;
    }

    const payload = {
      project_id: projectId,
      title,
      description,
      reason,
      timeline_impact_days: parseInt(timelineDays || '0', 10),
      cost_impact_cents: totalDelta,
      diff,
      category_notes: Object.entries(notesByCategory)
        .map(([id, note]) => ({ budget_category_id: id, note: note.trim() }))
        .filter((n) => n.note.length > 0),
      management_fee_override_rate: mgmtFeeChanged ? mgmtFeeRateNum : null,
      management_fee_override_reason: mgmtFeeChanged ? mgmtFeeReason.trim() : null,
    };

    const result =
      mode.kind === 'edit'
        ? await updateChangeOrderV2Action({ ...payload, id: mode.changeOrderId })
        : await createChangeOrderV2Action(payload);

    if (!result.ok) {
      setError(result.error);
      setLoading(false);
      return;
    }
    // Always land on the CO detail page so the operator can review the
    // full diff + customer-facing summary before clicking "Send for
    // Approval". Customer-facing email/SMS only fire from there.
    if (goToPreview && result.id) {
      router.push(`/projects/${projectId}/change-orders/${result.id}`);
    } else {
      router.push(`/projects/${projectId}?tab=budget`);
    }
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {error ? <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}

      {/* Total-impact header. Sits above the form metadata so it's the first */}
      {/* thing the operator sees and stays anchored as they scroll the line */}
      {/* items below. Inline `position: sticky` because Tailwind's `sticky` */}
      {/* class was reportedly being overridden / failing to pin in this */}
      {/* layout — explicit style is the durable fix. */}
      <div
        style={{ position: 'sticky', top: 0, zIndex: 30 }}
        className="flex items-baseline justify-between gap-4 rounded-lg border bg-background p-4 shadow-sm"
      >
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Total Cost Impact</p>
          <p
            className={cn(
              'text-2xl font-semibold tabular-nums',
              totalDelta < 0 && 'text-emerald-700',
              totalDelta > 0 && 'text-foreground',
            )}
          >
            {totalDelta >= 0 ? '+' : ''}
            {formatCurrency(totalDelta)}
          </p>
        </div>
        <p className="hidden max-w-xs text-right text-xs text-muted-foreground sm:block">
          Edit qty or price on any line. Strikethrough to remove. "+ Add line" to add new scope.
        </p>
      </div>

      <div className="space-y-4 rounded-lg border p-4">
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="cd-title">
            Title
          </label>
          <input
            id="cd-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm"
            placeholder="e.g. Add pot lights to kitchen"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="cd-desc">
            Description
          </label>
          <textarea
            id="cd-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full rounded-md border px-3 py-2 text-sm"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="cd-reason">
              Reason (optional)
            </label>
            <input
              id="cd-reason"
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="cd-timeline">
              Timeline Impact (days)
            </label>
            <input
              id="cd-timeline"
              type="number"
              value={timelineDays}
              onChange={(e) => setTimelineDays(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="rounded-md border bg-muted/20 p-3">
          <div className="flex items-baseline justify-between gap-3">
            <label className="block text-sm font-medium" htmlFor="cd-mgmt-fee">
              Management fee
            </label>
            <p className="text-xs text-muted-foreground">Project default: {defaultRatePct}%</p>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              id="cd-mgmt-fee"
              type="number"
              step="0.01"
              min="0"
              max="50"
              value={mgmtFeePct}
              onChange={(e) => setMgmtFeePct(e.target.value)}
              className="h-8 w-24 rounded-md border bg-background px-2 text-right text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <span className="text-sm">%</span>
            <span className="text-xs text-muted-foreground tabular-nums">
              = {formatCurrency(Math.round(Math.max(totalDelta, 0) * mgmtFeeRateNum))} on this CO
            </span>
          </div>
          {mgmtFeeChanged ? (
            <div className="mt-3">
              <label className="mb-1 block text-xs font-medium" htmlFor="cd-mgmt-fee-reason">
                Reason for adjustment
                <span className="ml-1 text-amber-700">(required)</span>
              </label>
              <input
                id="cd-mgmt-fee-reason"
                type="text"
                value={mgmtFeeReason}
                onChange={(e) => setMgmtFeeReason(e.target.value)}
                placeholder="e.g. Scaling back as project size grew past budget"
                className="h-8 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Recorded on the project overview audit trail. Visible to admins, not the customer.
              </p>
            </div>
          ) : null}
        </div>
      </div>

      {/* Per-section table — mirrors the Budget tab's column structure */}
      {/* (chevron / label / qty / unit price / total / action) so values */}
      {/* land in the same x-position whether you're looking at the budget */}
      {/* or editing a CO. Sticky thead per section; thead handoff is */}
      {/* automatic as the operator scrolls past one section into the */}
      {/* next. */}
      {Array.from(categoriesBySection.entries()).map(([section, categories]) => {
        const sectionEnvTotal = categories.reduce((s, c) => s + c.estimate_cents, 0);
        return (
          <div key={section}>
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                {section}
              </h3>
              <div className="text-xs tabular-nums text-muted-foreground">
                Section total:{' '}
                <span className="font-semibold text-foreground">
                  {formatCurrency(sectionEnvTotal)}
                </span>
              </div>
            </div>
            <div className="overflow-x-clip [overflow-y:visible] rounded-md border">
              <table className="w-full min-w-[640px] table-fixed text-sm">
                <colgroup>
                  <col className="w-10" />
                  <col />
                  <col className="w-20" />
                  <col className="w-28" />
                  <col className="w-32" />
                  <col className="w-12" />
                </colgroup>
                <thead className="[&>tr>th]:bg-muted">
                  <tr className="border-b">
                    <th className="px-1 py-1.5" />
                    <th className="px-2 py-1.5 text-left text-xs uppercase tracking-wide font-medium text-muted-foreground">
                      Category / line
                    </th>
                    <th className="px-3 py-1.5 text-right text-xs uppercase tracking-wide font-medium text-muted-foreground">
                      Qty
                    </th>
                    <th className="px-3 py-1.5 text-right text-xs uppercase tracking-wide font-medium text-muted-foreground">
                      Unit price
                    </th>
                    <th className="px-3 py-1.5 text-right text-xs uppercase tracking-wide font-medium text-muted-foreground">
                      Total
                    </th>
                    <th className="px-1 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {categories.map((category) => {
                    const lines = linesByCategory.get(category.id) ?? [];
                    const addedHere = added.filter((a) => a.budget_category_id === category.id);
                    const hasAnyLineEdit =
                      lines.some((l) => removedIds.has(l.id) || editsById[l.id] !== undefined) ||
                      addedHere.length > 0;
                    const envRaw = envelopeEdits[category.id];
                    const newEnvCents =
                      envRaw !== undefined && envRaw !== ''
                        ? Math.round(Number(envRaw) * 100)
                        : null;
                    const envDelta =
                      !hasAnyLineEdit && newEnvCents !== null && !Number.isNaN(newEnvCents)
                        ? newEnvCents - category.estimate_cents
                        : 0;
                    const hasAnyEdit = hasAnyLineEdit || envDelta !== 0;
                    const hasNote = (notesByCategory[category.id]?.trim() ?? '').length > 0;
                    const isExpanded =
                      forceOpenCategories.has(category.id) ||
                      addedHere.length > 0 ||
                      hasAnyEdit ||
                      hasNote;
                    function toggleOpen() {
                      setForceOpenCategories((prev) => {
                        const next = new Set(prev);
                        if (next.has(category.id)) next.delete(category.id);
                        else next.add(category.id);
                        return next;
                      });
                    }
                    return (
                      <Fragment key={category.id}>
                        {/* Category header row */}
                        <tr className="border-b bg-muted/40">
                          <td className="px-1 py-1.5 align-top">
                            <button
                              type="button"
                              onClick={toggleOpen}
                              aria-label={isExpanded ? 'Collapse category' : 'Expand category'}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              {isExpanded ? (
                                <ChevronDown className="size-4" />
                              ) : (
                                <ChevronRight className="size-4" />
                              )}
                            </button>
                          </td>
                          <td className="px-2 py-1.5 align-top" colSpan={3}>
                            <button
                              type="button"
                              onClick={toggleOpen}
                              className="block w-full text-left"
                            >
                              <span className="text-sm font-medium">{category.name}</span>
                              {category.description ? (
                                <span className="mt-0.5 block text-[11px] text-muted-foreground/80 line-clamp-2">
                                  {category.description}
                                </span>
                              ) : null}
                            </button>
                          </td>
                          <td className="px-3 py-1.5 text-right align-top">
                            <div className="flex items-center justify-end gap-1.5">
                              <span className="text-xs text-muted-foreground/60">$</span>
                              <input
                                type="number"
                                step="0.01"
                                value={
                                  envelopeEdits[category.id] ??
                                  (category.estimate_cents / 100).toFixed(2)
                                }
                                disabled={hasAnyLineEdit}
                                onChange={(e) =>
                                  setEnvelopeEdits((prev) => ({
                                    ...prev,
                                    [category.id]: e.target.value,
                                  }))
                                }
                                title={
                                  hasAnyLineEdit
                                    ? 'Editing line items already; budget is implied by line totals'
                                    : 'Adjust the budget for this category'
                                }
                                className="h-7 w-24 rounded-md border bg-background px-2 text-right text-sm tabular-nums disabled:opacity-50"
                              />
                            </div>
                            {envDelta !== 0 ? (
                              <div className="mt-0.5 text-right">
                                <Money cents={envDelta} signed className="text-xs font-medium" />
                              </div>
                            ) : null}
                          </td>
                          <td className="px-1 py-1.5 align-top" />
                        </tr>

                        {/* Note row (when expanded) */}
                        {isExpanded ? (
                          <tr className="border-b bg-muted/10">
                            <td />
                            <td colSpan={5} className="px-2 py-1.5">
                              <input
                                type="text"
                                value={notesByCategory[category.id] ?? ''}
                                onChange={(e) =>
                                  setNotesByCategory((prev) => ({
                                    ...prev,
                                    [category.id]: e.target.value,
                                  }))
                                }
                                placeholder="Note for this category (optional — shown to the customer)"
                                className="h-7 w-full rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
                              />
                            </td>
                          </tr>
                        ) : null}

                        {/* Existing lines */}
                        {isExpanded
                          ? lines.map((line) => {
                              const isRemoved = removedIds.has(line.id);
                              const edit = editsById[line.id];
                              const isModified = edit !== undefined;
                              const newQty =
                                edit?.qty !== undefined ? Number(edit.qty) : Number(line.qty);
                              const newUnitPriceCents =
                                edit?.unit_price_dollars !== undefined
                                  ? Math.round(Number(edit.unit_price_dollars) * 100)
                                  : line.unit_price_cents;
                              const newLinePrice = Math.round(newQty * newUnitPriceCents);
                              const delta = isRemoved
                                ? -line.line_price_cents
                                : isModified
                                  ? newLinePrice - line.line_price_cents
                                  : 0;

                              // Compact view: line is unmodified context.
                              // Click qty / price values to enter edit mode.
                              if (!isRemoved && !isModified) {
                                return (
                                  <tr key={line.id} className="border-b last:border-0">
                                    <td />
                                    <td className="px-2 py-1.5 align-top">
                                      <div className="font-medium">{line.label}</div>
                                      {line.notes ? (
                                        <div className="text-[11px] text-muted-foreground/70 line-clamp-2">
                                          {line.notes}
                                        </div>
                                      ) : null}
                                    </td>
                                    <td className="px-3 py-1.5 text-right align-top text-muted-foreground">
                                      <button
                                        type="button"
                                        onClick={() => setEdit(line.id, {})}
                                        title="Click to edit qty"
                                        className="hover:text-foreground hover:underline tabular-nums"
                                      >
                                        {Number(line.qty)} {line.unit}
                                      </button>
                                    </td>
                                    <td className="px-3 py-1.5 text-right align-top text-muted-foreground">
                                      <button
                                        type="button"
                                        onClick={() => setEdit(line.id, {})}
                                        title="Click to edit price"
                                        className="hover:text-foreground hover:underline"
                                      >
                                        <Money cents={line.unit_price_cents} />
                                      </button>
                                    </td>
                                    <td className="px-3 py-1.5 text-right align-top">
                                      <Money cents={line.line_price_cents} emphasis />
                                    </td>
                                    <td className="px-1 py-1.5 text-right align-top">
                                      <button
                                        type="button"
                                        onClick={() => toggleRemove(line.id)}
                                        aria-label="Remove line"
                                        title="Remove line"
                                        className="rounded p-1 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
                                      >
                                        <X className="size-3.5" />
                                      </button>
                                    </td>
                                  </tr>
                                );
                              }

                              // Removed line: strikethrough, restore button.
                              if (isRemoved) {
                                return (
                                  <tr
                                    key={line.id}
                                    className="border-b bg-rose-50/60 last:border-0"
                                  >
                                    <td />
                                    <td className="px-2 py-1.5 align-top">
                                      <div className="flex items-center gap-2">
                                        <span className="shrink-0 rounded-full bg-rose-200/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-rose-900">
                                          Removed
                                        </span>
                                        <span className="font-medium line-through">
                                          {line.label}
                                        </span>
                                      </div>
                                      <input
                                        type="text"
                                        value={editsById[line.id]?.notes ?? ''}
                                        onChange={(e) =>
                                          setEdit(line.id, { notes: e.target.value })
                                        }
                                        placeholder="Note (optional — why this line is being removed)"
                                        className="mt-1.5 h-7 w-full rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
                                      />
                                    </td>
                                    <td className="px-3 py-1.5 text-right align-top text-muted-foreground line-through tabular-nums">
                                      {Number(line.qty)} {line.unit}
                                    </td>
                                    <td className="px-3 py-1.5 text-right align-top text-muted-foreground line-through">
                                      <Money cents={line.unit_price_cents} />
                                    </td>
                                    <td className="px-3 py-1.5 text-right align-top">
                                      <Money cents={delta} signed emphasis />
                                    </td>
                                    <td className="px-1 py-1.5 text-right align-top">
                                      <button
                                        type="button"
                                        onClick={() => toggleRemove(line.id)}
                                        aria-label="Restore"
                                        title="Restore"
                                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                                      >
                                        <RotateCcw className="size-3.5" />
                                      </button>
                                    </td>
                                  </tr>
                                );
                              }

                              // Modified line: inputs visible, "was" subtext.
                              return (
                                <tr key={line.id} className="border-b bg-amber-50/70 last:border-0">
                                  <td />
                                  <td className="px-2 py-1.5 align-top">
                                    <div className="flex items-center gap-2">
                                      <span className="shrink-0 rounded-full bg-amber-200/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-900">
                                        Edited
                                      </span>
                                      <span className="font-medium">{line.label}</span>
                                    </div>
                                    <div className="mt-0.5 text-[11px] text-muted-foreground/80 tabular-nums">
                                      was {Number(line.qty)} {line.unit} @{' '}
                                      <Money cents={line.unit_price_cents} /> ={' '}
                                      <Money cents={line.line_price_cents} />
                                    </div>
                                    <input
                                      type="text"
                                      value={editsById[line.id]?.notes ?? ''}
                                      onChange={(e) => setEdit(line.id, { notes: e.target.value })}
                                      placeholder="Note (optional — explains this change)"
                                      className="mt-1.5 h-7 w-full rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
                                    />
                                  </td>
                                  <td className="px-3 py-1.5 align-top">
                                    <Input
                                      type="number"
                                      step="0.01"
                                      value={edit?.qty !== undefined ? edit.qty : String(line.qty)}
                                      onChange={(e) => setEdit(line.id, { qty: e.target.value })}
                                      className="h-7 text-right text-sm"
                                    />
                                  </td>
                                  <td className="px-3 py-1.5 align-top">
                                    <Input
                                      type="number"
                                      step="0.01"
                                      value={
                                        edit?.unit_price_dollars !== undefined
                                          ? edit.unit_price_dollars
                                          : (line.unit_price_cents / 100).toFixed(2)
                                      }
                                      onChange={(e) =>
                                        setEdit(line.id, { unit_price_dollars: e.target.value })
                                      }
                                      className="h-7 text-right text-sm"
                                    />
                                  </td>
                                  <td className="px-3 py-1.5 text-right align-top">
                                    {delta !== 0 ? (
                                      <Money cents={delta} signed emphasis />
                                    ) : (
                                      <Money
                                        cents={line.line_price_cents}
                                        className="text-muted-foreground"
                                      />
                                    )}
                                  </td>
                                  <td className="px-1 py-1.5 text-right align-top">
                                    <button
                                      type="button"
                                      onClick={() => clearEdit(line.id)}
                                      aria-label="Discard edit"
                                      title="Discard edit"
                                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                                    >
                                      <X className="size-3.5" />
                                    </button>
                                  </td>
                                </tr>
                              );
                            })
                          : null}

                        {/* Added lines */}
                        {isExpanded
                          ? addedHere.map((a) => {
                              const qty = Number(a.qty);
                              const unitPriceCents = Math.round(Number(a.unit_price_dollars) * 100);
                              const linePrice =
                                Number.isFinite(qty) && Number.isFinite(unitPriceCents)
                                  ? Math.round(qty * unitPriceCents)
                                  : 0;
                              return (
                                <tr
                                  key={a.tempId}
                                  className="border-b bg-emerald-50/50 last:border-0"
                                >
                                  <td />
                                  <td className="px-2 py-1.5 align-top">
                                    <div className="flex items-center gap-2">
                                      <span className="shrink-0 rounded-full bg-emerald-200/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-900">
                                        New
                                      </span>
                                      <Input
                                        type="text"
                                        value={a.label}
                                        onChange={(e) =>
                                          setAdded_(a.tempId, { label: e.target.value })
                                        }
                                        placeholder="Description"
                                        className="h-7 flex-1 text-sm"
                                      />
                                    </div>
                                    <input
                                      type="text"
                                      value={a.notes}
                                      onChange={(e) =>
                                        setAdded_(a.tempId, { notes: e.target.value })
                                      }
                                      placeholder="Note (optional — explains this addition)"
                                      className="mt-1.5 h-7 w-full rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
                                    />
                                  </td>
                                  <td className="px-3 py-1.5 align-top">
                                    <Input
                                      type="number"
                                      step="0.01"
                                      value={a.qty}
                                      onChange={(e) => setAdded_(a.tempId, { qty: e.target.value })}
                                      className="h-7 text-right text-sm"
                                      placeholder="Qty"
                                    />
                                  </td>
                                  <td className="px-3 py-1.5 align-top">
                                    <Input
                                      type="number"
                                      step="0.01"
                                      value={a.unit_price_dollars}
                                      onChange={(e) =>
                                        setAdded_(a.tempId, {
                                          unit_price_dollars: e.target.value,
                                        })
                                      }
                                      className="h-7 text-right text-sm"
                                      placeholder="$"
                                    />
                                  </td>
                                  <td className="px-3 py-1.5 text-right align-top">
                                    <Money cents={linePrice} signed emphasis />
                                  </td>
                                  <td className="px-1 py-1.5 text-right align-top">
                                    <button
                                      type="button"
                                      onClick={() => removeAdded(a.tempId)}
                                      aria-label="Cancel add"
                                      title="Cancel add"
                                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                                    >
                                      <X className="size-3.5" />
                                    </button>
                                  </td>
                                </tr>
                              );
                            })
                          : null}

                        {/* Add line footer (when expanded) */}
                        {isExpanded ? (
                          <tr className="border-b last:border-0">
                            <td />
                            <td colSpan={5} className="px-2 py-1.5">
                              <Button
                                type="button"
                                size="xs"
                                variant="outline"
                                onClick={() => addLine(category.id)}
                              >
                                <Plus className="size-3" />
                                Add line to {category.name}
                              </Button>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}

                  {/* New-category row at end of section */}
                  {creatingCategory === section ? (
                    <tr className="border-b last:border-0">
                      <td />
                      <td colSpan={5} className="px-2 py-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            New category in {section}
                          </span>
                          <Input
                            value={newCategoryName}
                            autoFocus
                            onChange={(e) => setNewCategoryName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                commitNewCategory(section);
                              } else if (e.key === 'Escape') {
                                setCreatingCategory(null);
                                setNewCategoryName('');
                              }
                            }}
                            placeholder="e.g. Basement waterproofing"
                            className="h-7 flex-1 text-sm"
                            disabled={creatingPending}
                          />
                          <Button
                            type="button"
                            size="xs"
                            onClick={() => commitNewCategory(section)}
                            disabled={creatingPending || !newCategoryName.trim()}
                          >
                            Add
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            onClick={() => {
                              setCreatingCategory(null);
                              setNewCategoryName('');
                            }}
                            disabled={creatingPending}
                          >
                            Cancel
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr className="last:border-0">
                      <td />
                      <td colSpan={5} className="px-2 py-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setCreatingCategory(section);
                            setNewCategoryName('');
                          }}
                          className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <Plus className="size-3" />
                          New category in {section}
                        </button>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {/* Add a brand-new section (with its first category). Sections are
          free-form per project — see migration 0072. */}
      {creatingCategory === '__new_section__' ? (
        <div className="rounded-md border border-dashed p-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            New section
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={newSectionName}
              autoFocus
              onChange={(e) => setNewSectionName(e.target.value)}
              placeholder="Section name (e.g. Basement)"
              className="h-8 flex-1 text-sm"
              disabled={creatingPending}
            />
            <Input
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitNewSection();
                } else if (e.key === 'Escape') {
                  setCreatingCategory(null);
                  setNewCategoryName('');
                  setNewSectionName('');
                }
              }}
              placeholder="First category (e.g. Waterproofing)"
              className="h-8 flex-1 text-sm"
              disabled={creatingPending}
            />
            <Button
              type="button"
              size="sm"
              onClick={() => commitNewSection()}
              disabled={creatingPending || !newSectionName.trim() || !newCategoryName.trim()}
            >
              Add
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setCreatingCategory(null);
                setNewCategoryName('');
                setNewSectionName('');
              }}
              disabled={creatingPending}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setCreatingCategory('__new_section__');
            setNewCategoryName('');
            setNewSectionName('');
          }}
          className="self-start rounded-md border border-dashed px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="mr-1 inline size-3" />
          New section
        </button>
      )}

      <div className="flex gap-3 border-t pt-4">
        {isEdit && mode.kind === 'edit' ? (
          <Link
            href={`/projects/${projectId}/change-orders/${mode.changeOrderId}`}
            className="inline-flex items-center rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            Cancel
          </Link>
        ) : (
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => handleSubmit(false)}
          >
            {loading ? 'Saving…' : 'Save as Draft'}
          </Button>
        )}
        <Button type="button" disabled={loading} onClick={() => handleSubmit(true)}>
          {loading ? 'Saving…' : isEdit ? 'Save changes' : 'Save & Preview'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Preview shows exactly what the customer will see. Nothing is sent until you click "Send for
        Approval" on the next screen.
      </p>
    </div>
  );
}
