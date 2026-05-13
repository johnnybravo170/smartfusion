/**
 * Read-only homeowner-facing selections panel grouped by room.
 *
 * No client interactivity needed — this is a static reference list. Kept
 * as a server component (no 'use client') so it streams faster and
 * doesn't ship a JS bundle for the homeowner.
 */

import type { ProjectSelection } from '@/lib/db/queries/project-selections';
import { formatCurrency } from '@/lib/pricing/calculator';
import {
  type SelectionCategory,
  selectionCategoryLabels,
} from '@/lib/validators/project-selection';

export function PortalSelections({
  groups,
  signedUrls = new Map(),
}: {
  groups: Array<{ room: string; items: ProjectSelection[] }>;
  /** Map of storage_path → signed URL so photo_refs can render. */
  signedUrls?: Map<string, string>;
}) {
  if (groups.length === 0) return null;
  return (
    <section className="space-y-4" aria-labelledby="selections-heading">
      <div>
        <h2 id="selections-heading" className="text-base font-semibold">
          Selections
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          What we used in your home — paint codes, tile, fixtures. You&rsquo;ll get this in your
          final Home Record at the end of the job.
        </p>
      </div>

      {groups.map((group) => (
        <div key={group.room} className="rounded-lg border bg-card">
          <h3 className="border-b px-4 py-2 text-sm font-semibold">{group.room}</h3>
          <ul className="divide-y">
            {group.items.map((sel) => {
              const headline = [sel.brand, sel.name].filter(Boolean).join(' ');
              const detail = [sel.code, sel.finish].filter(Boolean).join(' • ');
              return (
                <li key={sel.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium">
                      {selectionCategoryLabels[sel.category as SelectionCategory] ?? sel.category}
                    </span>
                    {headline ? <span className="text-sm font-medium">{headline}</span> : null}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    {detail ? <span>{detail}</span> : null}
                    {sel.supplier ? <span>{sel.supplier}</span> : null}
                    {sel.sku ? <span>SKU {sel.sku}</span> : null}
                    {sel.warranty_url ? (
                      <a
                        href={sel.warranty_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        Warranty info
                      </a>
                    ) : null}
                  </div>
                  {sel.allowance_cents != null || sel.actual_cost_cents != null ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {sel.actual_cost_cents != null && sel.allowance_cents != null
                        ? sel.actual_cost_cents > sel.allowance_cents
                          ? `+${formatCurrency(sel.actual_cost_cents - sel.allowance_cents)} over allowance`
                          : sel.actual_cost_cents < sel.allowance_cents
                            ? `${formatCurrency(sel.allowance_cents - sel.actual_cost_cents)} under allowance`
                            : 'On allowance'
                        : sel.allowance_cents != null
                          ? `Allowance ${formatCurrency(sel.allowance_cents)}`
                          : sel.actual_cost_cents != null
                            ? `Cost ${formatCurrency(sel.actual_cost_cents)}`
                            : null}
                    </p>
                  ) : null}
                  {sel.notes ? (
                    <p className="mt-1 text-xs text-muted-foreground">{sel.notes}</p>
                  ) : null}
                  {sel.photo_refs.length > 0 ? (
                    <div className="mt-2 grid grid-cols-3 gap-1.5 sm:grid-cols-5">
                      {sel.photo_refs.map((ref) => {
                        const url = signedUrls.get(ref.storage_path);
                        if (!url) return null;
                        return (
                          // biome-ignore lint/performance/noImgElement: signed URLs
                          <img
                            key={ref.photo_id}
                            src={url}
                            alt={ref.caption ?? ''}
                            loading="lazy"
                            className="aspect-square rounded-md border object-cover"
                          />
                        );
                      })}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
