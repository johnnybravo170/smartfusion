import type { ChangeOrderLineRow } from '@/lib/db/queries/change-orders';
import { formatCurrency } from '@/lib/pricing/calculator';

type CategoryNote = { budget_category_id: string; note: string };

export function ChangeOrderDiffView({
  diffLines,
  categoryNotes,
  budgetCategoryNamesById,
}: {
  diffLines: ChangeOrderLineRow[];
  categoryNotes: CategoryNote[];
  budgetCategoryNamesById: Record<string, string>;
}) {
  const hasNotes = categoryNotes.length > 0;
  const hasLines = diffLines.length > 0;
  if (!hasNotes && !hasLines) return null;

  return (
    <div className="space-y-4">
      {hasNotes ? (
        <div className="rounded-lg border p-4">
          <p className="mb-3 text-xs text-muted-foreground">Notes by Category</p>
          <ul className="space-y-2 text-sm">
            {categoryNotes.map((n) => (
              <li key={n.budget_category_id}>
                <span className="font-medium">
                  {budgetCategoryNamesById[n.budget_category_id] ?? n.budget_category_id}
                </span>
                <span className="ml-2 italic text-muted-foreground">{n.note}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {hasLines ? (
        <div className="rounded-lg border p-4">
          <p className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">
            Line-level Changes
          </p>
          <div className="overflow-x-auto">
            {/* table-fixed + colgroup so numeric cols are anchored on the */}
            {/* right and the Line description absorbs slack. Per-cell px-3 */}
            {/* gives the columns visible separation — without it the */}
            {/* numbers run together ("$0.00$7,350.00+$7,350.00") and the */}
            {/* CATEGORY/BEFORE headers read as one word. */}
            <table className="w-full min-w-[640px] table-fixed text-sm">
              <colgroup>
                <col className="w-20" />
                <col />
                <col className="w-28" />
                <col className="w-24" />
                <col className="w-24" />
                <col className="w-24" />
              </colgroup>
              <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 text-left font-medium">Action</th>
                  <th className="px-3 py-2 text-left font-medium">Line</th>
                  <th className="px-3 py-2 text-left font-medium">Category</th>
                  <th className="px-3 py-2 text-right font-medium">Before</th>
                  <th className="px-3 py-2 text-right font-medium">After</th>
                  <th className="px-3 py-2 text-right font-medium">Delta</th>
                </tr>
              </thead>
              <tbody>
                {diffLines.map((d) => {
                  const before = d.before_snapshot as {
                    label?: string;
                    qty?: number;
                    line_price_cents?: number;
                    estimate_cents?: number;
                    kind?: string;
                  } | null;
                  const isEnvelope = d.action === 'modify_envelope';
                  const beforePrice = isEnvelope
                    ? (before?.estimate_cents ?? 0)
                    : (before?.line_price_cents ?? 0);
                  const afterPrice = d.action === 'remove' ? 0 : (d.line_price_cents ?? 0);
                  const delta = afterPrice - beforePrice;
                  const label = isEnvelope
                    ? `Budget: ${d.label ?? '—'}`
                    : (d.label ?? before?.label ?? '—');
                  return (
                    <tr key={d.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-3 py-2 align-top">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                            d.action === 'add'
                              ? 'bg-emerald-100 text-emerald-800'
                              : d.action === 'remove'
                                ? 'bg-red-100 text-red-800'
                                : d.action === 'modify_envelope'
                                  ? 'bg-blue-100 text-blue-800'
                                  : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {d.action === 'modify_envelope' ? 'budget' : d.action}
                        </span>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <div>{label}</div>
                        {d.notes ? (
                          <div className="mt-0.5 text-xs italic text-muted-foreground">
                            {d.notes}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                        {d.budget_category_id
                          ? (budgetCategoryNamesById[d.budget_category_id] ?? '—')
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-right align-top tabular-nums text-muted-foreground">
                        {d.action === 'add' ? '—' : formatCurrency(beforePrice)}
                      </td>
                      <td className="px-3 py-2 text-right align-top tabular-nums">
                        {d.action === 'remove' ? '—' : formatCurrency(afterPrice)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right align-top font-medium tabular-nums ${delta < 0 ? 'text-emerald-700' : ''}`}
                      >
                        {delta >= 0 ? '+' : ''}
                        {formatCurrency(delta)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
