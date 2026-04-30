/**
 * "Unsent changes since v{N}" chip on the project page.
 *
 * Hidden when the project has no snapshot yet (legacy / pre-snapshot
 * projects, or projects still in planning) OR when the working state
 * matches the latest snapshot. Otherwise it surfaces a count + a
 * deep-link to the diff review screen on the Budget tab.
 *
 * Drives the "diff-tracked + intentional-send" post-approval flow per
 * decision 6790ef2b. The review screen itself is a separate kanban
 * card; this chip just provides the entry point.
 */

import { ArrowRight, FilePen } from 'lucide-react';
import Link from 'next/link';
import { getUnsentDiff } from '@/lib/db/queries/project-scope-diff';

export async function UnsentChangesChip({ projectId }: { projectId: string }) {
  const diff = await getUnsentDiff(projectId);
  if (!diff.has_baseline || diff.total_change_count === 0) return null;

  const versionLabel = `v${diff.baseline_version ?? 1}`;
  const deltaSign = diff.total_delta_cents > 0 ? '+' : diff.total_delta_cents < 0 ? '−' : '';
  const deltaAbs = Math.abs(diff.total_delta_cents);
  const deltaText =
    diff.total_delta_cents !== 0
      ? ` · ${deltaSign}$${(deltaAbs / 100).toLocaleString(undefined, {
          minimumFractionDigits: 0,
          maximumFractionDigits: 2,
        })}`
      : '';

  return (
    <Link
      href={`/projects/${projectId}?tab=budget&review=diff`}
      className="mb-4 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-900 hover:bg-amber-100/80 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <FilePen className="size-3.5 shrink-0" />
      <span className="flex-1">
        <span className="font-semibold">
          {diff.total_change_count} unsent {diff.total_change_count === 1 ? 'change' : 'changes'}
        </span>{' '}
        since {versionLabel}
        {deltaText}
        {diff.suggested_co_count > 0 ? (
          <>
            {' '}
            · {diff.suggested_co_count}{' '}
            {diff.suggested_co_count === 1 ? 'looks customer-impacting' : 'look customer-impacting'}
          </>
        ) : null}
      </span>
      <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide">
        Review
        <ArrowRight className="size-3" />
      </span>
    </Link>
  );
}
