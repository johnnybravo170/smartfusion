'use client';

/**
 * Inline banner shown above the Budget tab when at least one v2
 * change order has been applied. Makes it obvious that the numbers
 * reflect post-CO state without renaming the tab — the original
 * signed estimate is unchanged.
 *
 * Click "See history" to expand the banner inline into a chronological
 * timeline of every signed version (estimate v1 + each applied CO).
 * Click again to collapse. Same eye position, no floating popover.
 *
 * Hidden when no applied COs exist so we don't add noise to projects
 * that haven't gone through any change-order activity yet.
 */

import { ChevronDown, ChevronUp, ExternalLink, Info } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { ProjectVersionListItem } from '@/lib/db/queries/project-versions';
import { formatCurrency } from '@/lib/pricing/calculator';
import { cn } from '@/lib/utils';

export function AppliedChangeOrdersBanner({
  appliedCount,
  projectId,
  versions,
}: {
  appliedCount: number;
  projectId: string;
  versions: ProjectVersionListItem[];
}) {
  const [expanded, setExpanded] = useState(false);

  if (appliedCount <= 0) return null;

  return (
    <div className="mb-4 overflow-hidden rounded-md border border-blue-200 bg-blue-50/60 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-blue-100/60 dark:hover:bg-blue-950/60"
      >
        <Info className="size-3.5 shrink-0" />
        <span className="flex-1">
          Reflects <span className="font-semibold">{appliedCount}</span> applied change{' '}
          {appliedCount === 1 ? 'order' : 'orders'}. The original signed estimate is unchanged.
        </span>
        <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide">
          {expanded ? 'Hide history' : 'See history'}
          {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
        </span>
      </button>

      {expanded ? (
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
    ? `/projects/${projectId}/change-orders/${version.change_order_id}`
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
