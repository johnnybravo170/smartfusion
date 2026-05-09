/**
 * Pre-send warnings for an estimate. Two surfaces share this component:
 *
 *  - "card" variant — full amber notice rendered above the document on
 *    the estimate preview page; lists every issue with a deep-link to
 *    the Budget tab so the operator can fix.
 *  - "strip" variant — condensed inline summary inside the send-confirm
 *    dialog so the operator can't miss the issues at the moment they
 *    click Send.
 *
 * Non-blocking on either surface — the operator can override and send
 * anyway. See `src/lib/estimate/preflight.ts` for the rule set.
 */

import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import type { EstimatePreflight } from '@/lib/estimate/preflight';
import { formatCurrency } from '@/lib/pricing/calculator';

type Variant = 'card' | 'strip';

type Props = {
  preflight: EstimatePreflight;
  /** Project id — used by the "card" variant's "fix in Budget" link. */
  projectId?: string;
  variant?: Variant;
};

export function EstimatePreflightWarnings({ preflight, projectId, variant = 'card' }: Props) {
  if (preflight.totalIssues === 0) return null;

  const issuesLabel = preflight.totalIssues === 1 ? 'issue' : 'issues';

  if (variant === 'strip') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-300" />
        <div className="flex-1 space-y-1">
          <p className="font-medium">
            {preflight.totalIssues} {issuesLabel} flagged before send
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            {preflight.zeroLines.length > 0 ? (
              <li>
                {preflight.zeroLines.length} line{preflight.zeroLines.length === 1 ? '' : 's'} at
                $0.00
              </li>
            ) : null}
            {preflight.mismatches.length > 0 ? (
              <li>
                {preflight.mismatches.length} categor
                {preflight.mismatches.length === 1 ? 'y' : 'ies'} with envelope ≠ line totals
              </li>
            ) : null}
          </ul>
        </div>
      </div>
    );
  }

  return (
    <section className="mb-4 flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" />
      <div className="flex flex-1 flex-col gap-3 text-sm text-amber-900 dark:text-amber-100">
        <div>
          <p className="font-medium">
            Henry says check this — {preflight.totalIssues} {issuesLabel} before sending
          </p>
          <p className="text-amber-800/90 dark:text-amber-200/90">
            Non-blocking — you can still send. But these would be visible to the customer.
          </p>
        </div>

        {preflight.zeroLines.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-amber-800/80 dark:text-amber-200/80">
              {preflight.zeroLines.length} $0.00 line{preflight.zeroLines.length === 1 ? '' : 's'}
            </p>
            <ul className="list-disc space-y-0.5 pl-5 text-amber-900 dark:text-amber-100">
              {preflight.zeroLines.map((l) => (
                <li key={l.id}>
                  <span className="font-medium">{l.label}</span>
                  {l.categoryName ? (
                    <span className="text-amber-800/80 dark:text-amber-200/80">
                      {' '}
                      · {l.categoryName}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {preflight.mismatches.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-amber-800/80 dark:text-amber-200/80">
              {preflight.mismatches.length} categor
              {preflight.mismatches.length === 1 ? 'y' : 'ies'} where envelope ≠ line totals
            </p>
            <ul className="list-disc space-y-0.5 pl-5 text-amber-900 dark:text-amber-100">
              {preflight.mismatches.map((m) => (
                <li key={m.categoryId}>
                  <span className="font-medium">{m.categoryName}</span>: envelope{' '}
                  {formatCurrency(m.envelopeCents)} vs lines {formatCurrency(m.linesTotalCents)}{' '}
                  <span className="text-amber-800/80 dark:text-amber-200/80">
                    ({m.diffCents > 0 ? '+' : ''}
                    {formatCurrency(m.diffCents)}{' '}
                    {m.diffCents > 0 ? 'unallocated' : 'over envelope'})
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {projectId ? (
          <div>
            <Link
              href={`/projects/${projectId}?tab=budget`}
              className="inline-flex items-center rounded-md border border-amber-400 bg-white px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100 dark:hover:bg-amber-900/40"
            >
              Fix in Budget tab
            </Link>
          </div>
        ) : null}
      </div>
    </section>
  );
}
