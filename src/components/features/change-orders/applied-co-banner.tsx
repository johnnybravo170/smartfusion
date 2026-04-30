import { ArrowRight, Info } from 'lucide-react';
import Link from 'next/link';

/**
 * Inline banner shown above the Estimate + Budget tabs when at least one
 * v2 change order has been applied. Makes it obvious that the numbers
 * reflect post-CO state without renaming the tab — the original signed
 * estimate is unchanged.
 *
 * Hidden when no applied COs exist so we don't add noise to projects
 * that haven't gone through any change-order activity yet.
 */
export function AppliedChangeOrdersBanner({
  appliedCount,
  projectId,
}: {
  appliedCount: number;
  projectId: string;
}) {
  if (appliedCount <= 0) return null;
  return (
    <Link
      href={`/projects/${projectId}?tab=budget&versions=open`}
      className="mb-4 flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50/60 px-3 py-2 text-xs text-blue-900 hover:bg-blue-100/80 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100"
    >
      <Info className="size-3.5 shrink-0" />
      <span className="flex-1">
        Reflects <span className="font-semibold">{appliedCount}</span> applied change{' '}
        {appliedCount === 1 ? 'order' : 'orders'}. The original signed estimate is unchanged.
      </span>
      <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide">
        See history
        <ArrowRight className="size-3" />
      </span>
    </Link>
  );
}
