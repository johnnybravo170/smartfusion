/**
 * Customer-facing budget breakdown on the portal.
 *
 * Renders one of four layouts based on `summary.customer_view_mode`:
 *
 *   lump_sum  → headline contract total + (optional) scope summary.
 *               No per-bucket list, no "spent so far" — variance is
 *               suppressed (decision 73775c8e in ops).
 *   sections  → customer-facing groupings (defined per-project). No
 *               per-bucket variance. Falls back to `categories` mode
 *               when no sections are defined.
 *   categories → current per-bucket list with spent/total bars (the
 *               operator's "show variance" default for cost-plus jobs).
 *   detailed  → same as categories today; per-line breakdown is a
 *               follow-up (schema already supports `description_md`
 *               on cost lines).
 *
 * Visibility gating happens upstream via `shouldShowPortalBudget`. This
 * component only renders; it doesn't decide whether to render.
 */

import { RichTextDisplay } from '@/components/ui/rich-text-display';
import type {
  PortalBudgetCategory,
  PortalBudgetSection,
  PortalBudgetSummary,
} from '@/lib/db/queries/portal-budget';

const cadFormat = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: 'CAD',
  maximumFractionDigits: 0,
});

function formatCents(cents: number): string {
  return cadFormat.format(cents / 100);
}

function pct(spent: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((spent / total) * 100);
}

export function PortalBudgetDetail({ summary }: { summary: PortalBudgetSummary }) {
  const mode = summary.customer_view_mode;
  const hasAnyData = summary.categories.length > 0 || summary.project_total_cents > 0;
  if (!hasAnyData) return null;

  // Fall back to `categories` when sections mode is selected but no
  // sections have been defined yet — avoids an empty section list.
  const effectiveMode = mode === 'sections' && summary.sections.length === 0 ? 'categories' : mode;

  return (
    <div className="mb-8">
      <h2 className="mb-3 text-sm font-semibold">Where the budget stands</h2>

      {summary.customer_summary_md ? (
        <div className="mb-4 rounded-lg border border-muted bg-muted/30 p-4">
          <RichTextDisplay markdown={summary.customer_summary_md} />
        </div>
      ) : null}

      {/* Project-level rollup — variance shown only in categories/detailed. */}
      <ProjectRollup
        summary={summary}
        showVariance={effectiveMode === 'categories' || effectiveMode === 'detailed'}
      />

      {
        effectiveMode === 'sections' ? (
          <SectionsList sections={summary.sections} />
        ) : effectiveMode === 'categories' || effectiveMode === 'detailed' ? (
          <CategoriesList categories={summary.categories} />
        ) : null /* lump_sum: nothing further */
      }
    </div>
  );
}

function CategoriesList({ categories }: { categories: PortalBudgetCategory[] }) {
  if (categories.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {categories.map((cat) => {
        const p = pct(cat.spent_cents, cat.total_cents);
        const over = cat.spent_cents > cat.total_cents;
        return (
          <div key={cat.id} className="rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">{cat.name}</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {formatCents(cat.spent_cents)} of {formatCents(cat.total_cents)}
              </span>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-100">
              <div
                className={`h-2 rounded-full transition-all ${
                  over ? 'bg-amber-500' : 'bg-emerald-500'
                }`}
                style={{ width: `${Math.min(100, p)}%` }}
              />
            </div>
            <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{p}% used</span>
              {over ? <span className="font-medium text-amber-700">Over budget</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SectionsList({ sections }: { sections: PortalBudgetSection[] }) {
  if (sections.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {sections.map((s) => (
        <div key={s.id} className="rounded-lg border p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold">{s.name}</span>
            <span className="text-sm font-semibold tabular-nums">{formatCents(s.total_cents)}</span>
          </div>
          {s.description_md ? (
            <div className="mt-2 text-muted-foreground">
              <RichTextDisplay markdown={s.description_md} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * Combined project-level rollup. When `showVariance`:
 *   - Spent-against-budget bar on top
 *   - Paid-by-customer bar on the same scale below
 *
 * When variance is suppressed (lump_sum / sections):
 *   - Headline contract total only (no "Spent so far")
 *   - Paid bar still shown if there have been draws
 *
 * The customer-facing contract-total footnote (cost basis grossed up by
 * mgmt fee + tax) always renders when it differs from the cost-basis
 * total, since that's the number the homeowner actually pays.
 */
function ProjectRollup({
  summary,
  showVariance,
}: {
  summary: PortalBudgetSummary;
  showVariance: boolean;
}) {
  const total = summary.project_total_cents;
  const spent = summary.project_spent_cents;
  const paid = summary.draws_paid_cents;

  const spentPct = pct(spent, total);
  const paidPct = pct(paid, total);
  const spentOver = spent > total;

  const showSpentBar = showVariance && total > 0;
  const accent =
    showSpentBar && spentOver ? 'border-amber-300 bg-amber-50' : 'border-primary/30 bg-primary/5';

  return (
    <div className={`rounded-lg border p-4 shadow-sm ${accent}`}>
      {showSpentBar ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold">Spent so far</span>
            <span className="text-sm font-semibold tabular-nums">
              {formatCents(spent)} of {formatCents(total)}{' '}
              <span className="text-xs font-normal text-muted-foreground">
                (incl. change orders)
              </span>
            </span>
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-100">
            <div
              className={`h-2 rounded-full transition-all ${
                spentOver ? 'bg-amber-500' : 'bg-emerald-500'
              }`}
              style={{ width: `${Math.min(100, spentPct)}%` }}
            />
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{spentPct}% of budget</span>
            {spentOver ? <span className="font-medium text-amber-700">Over budget</span> : null}
          </div>
        </>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold">Project total</span>
          <span className="text-sm font-semibold tabular-nums">{formatCents(total)}</span>
        </div>
      )}

      {summary.has_draws ? (
        <>
          <div
            className={`${showSpentBar ? 'mt-4' : 'mt-3'} flex items-center justify-between gap-3`}
          >
            <span className="text-sm font-semibold">What you’ve paid</span>
            <span className="text-sm font-semibold tabular-nums">{formatCents(paid)}</span>
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-2 rounded-full bg-blue-500 transition-all"
              style={{ width: `${Math.min(100, paidPct)}%` }}
            />
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">{paidPct}% of budget</div>
        </>
      ) : null}

      {summary.customer_contract_total_cents > total ? (
        <p className="mt-3 border-t pt-2 text-[11px] text-muted-foreground">
          Your contract total: {formatCents(summary.customer_contract_total_cents)} (incl.
          management fee + {summary.tax_label})
        </p>
      ) : null}
    </div>
  );
}
