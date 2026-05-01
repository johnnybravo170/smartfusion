'use client';

/**
 * Merged signed-estimate banner on the Budget tab. One slim row that
 * covers two states the older UI surfaced as separate banners:
 *
 *   1. The estimate is signed → working budget edits don't touch the
 *      customer's signed scope. (Was an amber "Estimate is approved"
 *      block inside the table.)
 *   2. N change orders have been applied → the visible numbers reflect
 *      post-CO state. (Was a separate blue "Reflects X applied COs"
 *      banner above.)
 *
 * Both messages collapse into a single row:
 *
 *   ✓ Estimate signed · 2 applied COs   [See history ▾]   [+ Change Order]
 *
 * Mode-aware:
 *   - Editing mode: show the [+ Change Order] CTA on the right.
 *   - Executing mode: drop the CTA — operator is tracking, not authoring.
 *
 * Click "See history" to inline-expand the version timeline (every
 * signed estimate + applied CO).
 *
 * Hidden entirely when the estimate isn't approved yet.
 */

import { ChevronDown, ChevronUp, ExternalLink, FileEdit, Info } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ProjectVersionListItem } from '@/lib/db/queries/project-versions';
import { withFrom } from '@/lib/nav/from-link';
import { formatCurrency } from '@/lib/pricing/calculator';
import { cn } from '@/lib/utils';

export function AppliedChangeOrdersBanner({
  estimateStatus,
  appliedCount,
  projectId,
  versions,
  mode,
}: {
  estimateStatus: string;
  appliedCount: number;
  projectId: string;
  versions: ProjectVersionListItem[];
  mode: 'editing' | 'executing';
}) {
  const [expanded, setExpanded] = useState(false);

  // Banner only meaningful once the estimate is signed. Pre-approval
  // states have their own banners (EstimateSentBanner for pending).
  if (estimateStatus !== 'approved') return null;

  const hasHistory = appliedCount > 0;
  const showCta = mode === 'editing';

  return (
    <div className="overflow-hidden rounded-md border border-blue-200 bg-blue-50/60 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Info className="size-3.5 shrink-0" />
        <span className="flex-1 min-w-0">
          <span className="font-semibold">Estimate signed</span>
          {hasHistory ? (
            <>
              {' · '}
              <span className="font-semibold">{appliedCount}</span> applied change{' '}
              {appliedCount === 1 ? 'order' : 'orders'}
            </>
          ) : null}
          {showCta ? (
            <span className="hidden text-blue-800/80 sm:inline dark:text-blue-200/80">
              {' · '}edits update the working budget; scope changes go through a Change Order
            </span>
          ) : null}
        </span>
        {hasHistory ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide hover:bg-blue-100/60 dark:hover:bg-blue-950/60"
          >
            {expanded ? 'Hide history' : 'See history'}
            {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
        ) : null}
        {showCta ? (
          <Button asChild size="xs" variant="outline" className="bg-background">
            <Link href={`/projects/${projectId}/change-orders/new`}>
              <FileEdit className="size-3" />
              Change Order
            </Link>
          </Button>
        ) : null}
      </div>

      {expanded && hasHistory ? (
        <div className="border-t border-blue-200/60 bg-blue-50/30 px-3 py-2 dark:border-blue-900/60 dark:bg-blue-950/20">
          {versions.length === 0 ? (
            <p className="py-2 text-blue-800 dark:text-blue-200">
              No signed versions yet on this project.
            </p>
          ) : (
            <ol className="flex flex-col">
              {versions.map((v, i) => (
                <VersionRow
                  key={`v${v.version_number}-${v.signed_at}`}
                  version={v}
                  projectId={projectId}
                  isLast={i === versions.length - 1}
                />
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </div>
  );
}

function VersionRow({
  version,
  projectId,
  isLast,
}: {
  version: ProjectVersionListItem;
  projectId: string;
  isLast: boolean;
}) {
  const date = new Date(version.signed_at);
  const dateText = date.toLocaleDateString('en-CA', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  // Each row deep-links to the most relevant detail surface:
  //   - CO rows → CO detail page
  //   - v1 estimate row → estimate preview
  //   - legacy rows without snapshot or CO → no link
  const href = version.change_order_id
    ? withFrom(
        `/projects/${projectId}/change-orders/${version.change_order_id}`,
        `/projects/${projectId}?tab=budget`,
        'Budget',
      )
    : version.version_number === 1
      ? `/projects/${projectId}/estimate/preview`
      : null;

  const inner = (
    <>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-blue-200 text-[10px] font-semibold text-blue-900 dark:bg-blue-900 dark:text-blue-100',
          )}
        >
          v{version.version_number}
        </span>
        <span className="truncate font-medium">{version.label}</span>
      </div>
      <div className="flex items-center gap-3 text-[11px] text-blue-800/90 dark:text-blue-200/80">
        <span>
          {dateText}
          {version.signed_by_name ? ` · ${version.signed_by_name}` : ''}
        </span>
        {version.total_cents !== null ? (
          <span className="tabular-nums font-medium">{formatCurrency(version.total_cents)}</span>
        ) : null}
        {href ? <ExternalLink className="size-3 shrink-0 opacity-60" /> : null}
      </div>
    </>
  );

  const className = cn(
    'flex items-center justify-between gap-3 py-1.5',
    !isLast && 'border-b border-blue-200/40 dark:border-blue-900/40',
    href && 'hover:text-blue-950 dark:hover:text-white',
  );

  if (href) {
    return (
      <li>
        <Link href={href} className={className}>
          {inner}
        </Link>
      </li>
    );
  }
  return <li className={className}>{inner}</li>;
}
