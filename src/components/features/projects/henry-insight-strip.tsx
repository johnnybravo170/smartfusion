/**
 * Henry-supplied insight strip on the Budget page (Executing mode).
 * Renders up to 2 plain-English observations about the project's
 * current state. Each insight is a clickable link routing to the
 * relevant surface. Hidden in Editing mode — that surface is for
 * scope authoring, not status reading.
 */

import { ArrowRight, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { getProjectInsights } from '@/lib/db/queries/project-insights';
import { cn } from '@/lib/utils';

export async function HenryInsightStrip({ projectId }: { projectId: string }) {
  const insights = await getProjectInsights(projectId);
  if (insights.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      {insights.map((ins) => {
        const InsightInner = (
          <span className="flex items-center gap-2">
            <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1">{ins.message}</span>
            {ins.href ? <ArrowRight className="size-3 shrink-0" /> : null}
          </span>
        );
        const className = cn(
          'flex items-center gap-2 rounded-md border px-3 py-2 text-xs',
          ins.tone === 'amber' &&
            'border-amber-200 bg-amber-50/60 text-amber-900 hover:bg-amber-100/80 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100',
          ins.tone === 'emerald' &&
            'border-emerald-200 bg-emerald-50/60 text-emerald-900 hover:bg-emerald-100/80 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100',
          ins.tone === 'blue' &&
            'border-blue-200 bg-blue-50/60 text-blue-900 hover:bg-blue-100/80 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100',
          ins.tone === 'neutral' && 'bg-muted/30 text-muted-foreground',
        );
        if (ins.href) {
          return (
            <Link
              key={`${ins.kind}-${ins.message}`}
              href={`/projects/${projectId}${ins.href}`}
              className={className}
            >
              {InsightInner}
            </Link>
          );
        }
        return (
          <div key={`${ins.kind}-${ins.message}`} className={className}>
            {InsightInner}
          </div>
        );
      })}
    </div>
  );
}
