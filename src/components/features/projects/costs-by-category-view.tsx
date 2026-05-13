'use client';

/**
 * Alternate "Group by category" view for the project Spend tab.
 *
 * Mirrors the Budget tab structure (categories grouped by section),
 * surfacing every spend item attributed to that category in one place:
 * accepted vendor quotes, POs, bills, expenses. An "Unallocated"
 * leading group catches items missing a budget_category_id.
 *
 * Read-only summary view — full edit affordances stay on the per-type
 * subtabs. Toggle is in CostsTab.
 *
 * Honors `?focus=<category-name>` in the URL — used by the Budget tab's
 * "Spend →" drill-link to scroll + highlight a specific category.
 */

import { useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import type { ProjectBillRow } from '@/lib/db/queries/project-bills';
import type { SubQuoteRow } from '@/lib/db/queries/project-sub-quotes';
import type { PurchaseOrderRow } from '@/lib/db/queries/purchase-orders';
import { formatCurrency, formatCurrencyCompact } from '@/lib/pricing/calculator';
import type { ExpenseItem } from './project-costs-section';

type Category = { id: string; name: string; section: 'interior' | 'exterior' | 'general' };

type Row = {
  kind: 'quote' | 'po' | 'bill' | 'expense';
  id: string;
  label: string;
  sublabel?: string | null;
  amount_cents: number;
};

export function CostsByCategoryView({
  categories,
  bills,
  expenses,
  subQuotes,
  purchaseOrders,
}: {
  categories: Category[];
  bills: ProjectBillRow[];
  expenses: ExpenseItem[];
  subQuotes: SubQuoteRow[];
  purchaseOrders: PurchaseOrderRow[];
}) {
  // Build per-category row list. Items without a budget_category_id roll
  // into the "Unallocated" group keyed by the empty string.
  const rowsByCategory = new Map<string, Row[]>();
  function push(catId: string | null, row: Row) {
    const key = catId ?? '';
    const arr = rowsByCategory.get(key) ?? [];
    arr.push(row);
    rowsByCategory.set(key, arr);
  }

  for (const b of bills) {
    push(b.budget_category_id, {
      kind: 'bill',
      id: b.id,
      label: b.vendor ?? 'Bill',
      sublabel: b.bill_date ?? null,
      amount_cents: b.amount_cents,
    });
  }
  for (const e of expenses) {
    push(e.budget_category_id, {
      kind: 'expense',
      id: e.id,
      label: e.vendor ?? e.description ?? 'Expense',
      sublabel: e.expense_date ?? null,
      amount_cents: e.amount_cents,
    });
  }
  for (const q of subQuotes) {
    if (q.status !== 'accepted') continue;
    // Vendor quotes can split across categories via allocations.
    for (const a of q.allocations) {
      push(a.budget_category_id, {
        kind: 'quote',
        id: `${q.id}:${a.id}`,
        label: q.vendor_name,
        sublabel: q.scope_description ?? null,
        amount_cents: a.allocated_cents,
      });
    }
  }
  for (const po of purchaseOrders) {
    if (!['sent', 'acknowledged', 'received'].includes(po.status)) continue;
    // Sum line items per category for a clean per-category PO total. A
    // single PO touching three categories shows three rows.
    const byCat = new Map<string | null, number>();
    for (const it of po.items) {
      byCat.set(
        it.budget_category_id,
        (byCat.get(it.budget_category_id) ?? 0) + it.line_total_cents,
      );
    }
    for (const [catId, sum] of byCat.entries()) {
      push(catId, {
        kind: 'po',
        id: `${po.id}:${catId ?? 'none'}`,
        label: po.vendor,
        sublabel: po.po_number ? `PO #${po.po_number}` : 'PO',
        amount_cents: sum,
      });
    }
  }

  const sectionsByName = new Map<string, Category[]>();
  for (const b of categories) {
    const arr = sectionsByName.get(b.section) ?? [];
    arr.push(b);
    sectionsByName.set(b.section, arr);
  }
  const unallocated = rowsByCategory.get('') ?? [];

  const searchParams = useSearchParams();
  const focusName = (searchParams?.get('focus') ?? '').toLowerCase().trim();
  const focusedCategoryRef = useRef<HTMLDivElement | null>(null);

  // Scroll to the focused category on mount / focus change. Stays subtle
  // — no jarring jumps if the user is already scrolled.
  useEffect(() => {
    if (!focusName) return;
    const el = focusedCategoryRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusName]);

  return (
    <div className="space-y-6">
      {unallocated.length > 0 ? (
        <CategoryBlock name="Unallocated" rows={unallocated} highlight />
      ) : null}

      {Array.from(sectionsByName.entries()).map(([section, sectionCategories]) => (
        <div key={section}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {section}
          </h3>
          <div className="space-y-3">
            {sectionCategories.map((b) => {
              const rows = rowsByCategory.get(b.id) ?? [];
              if (rows.length === 0) return null;
              const isFocused = focusName.length > 0 && b.name.toLowerCase().trim() === focusName;
              return (
                <div key={b.id} ref={isFocused ? focusedCategoryRef : undefined}>
                  <CategoryBlock name={b.name} rows={rows} highlight={isFocused} />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function CategoryBlock({
  name,
  rows,
  highlight,
}: {
  name: string;
  rows: Row[];
  highlight?: boolean;
}) {
  const subtotal = rows.reduce((s, r) => s + r.amount_cents, 0);
  return (
    <div className={`rounded-md border ${highlight ? 'border-amber-300/60 bg-amber-50/30' : ''}`}>
      <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-2">
        <span className="text-sm font-medium">{name}</span>
        <span className="text-sm tabular-nums font-semibold">
          {formatCurrencyCompact(subtotal)}
        </span>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.kind}:${r.id}`} className="border-b last:border-0">
              <td className="px-3 py-1.5 w-20">
                <KindChip kind={r.kind} />
              </td>
              <td className="px-3 py-1.5">
                <div>{r.label}</div>
                {r.sublabel ? (
                  <div className="text-xs text-muted-foreground">{r.sublabel}</div>
                ) : null}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                {formatCurrency(r.amount_cents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KindChip({ kind }: { kind: Row['kind'] }) {
  const styles: Record<Row['kind'], string> = {
    quote: 'bg-blue-100 text-blue-800',
    po: 'bg-purple-100 text-purple-800',
    bill: 'bg-amber-100 text-amber-800',
    expense: 'bg-emerald-100 text-emerald-800',
  };
  const labels: Record<Row['kind'], string> = {
    quote: 'Quote',
    po: 'PO',
    bill: 'Bill',
    expense: 'Expense',
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${styles[kind]}`}
    >
      {labels[kind]}
    </span>
  );
}
