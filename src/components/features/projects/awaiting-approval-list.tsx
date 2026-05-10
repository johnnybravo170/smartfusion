/**
 * List of projects where the estimate has been sent and the contractor
 * is waiting on a customer decision. Each row surfaces the thing
 * operators actually care about at a glance: "have they looked yet?"
 *
 * Two variants:
 *   - `compact` (default): for the dashboard — shows up to `limit` rows,
 *     with "view all" footer when more exist.
 *   - `full`: for the /projects Awaiting-approval tab — shows every row.
 *
 * Rows link to the project's Estimate tab. Stale (not viewed after 3+
 * days) rows get an amber marker; viewed rows get a green "👁 N views"
 * badge with the last-viewed timestamp relative to now.
 */

import { ChevronRight, Eye, Mail, Send } from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { AwaitingApprovalProject } from '@/lib/db/queries/awaiting-approval';
import { formatCurrency } from '@/lib/pricing/calculator';
import { cn } from '@/lib/utils';

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function ViewBadge({ project }: { project: AwaitingApprovalProject }) {
  if (project.view_count === 0) {
    const stale = project.days_since_sent >= 3;
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
          stale
            ? 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200'
            : 'bg-muted text-muted-foreground',
        )}
      >
        <Mail className="size-3" />
        Not opened yet
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200">
      <Eye className="size-3" />
      Viewed {project.view_count}×
      {project.last_viewed_at ? ` · ${relativeTime(project.last_viewed_at)}` : ''}
    </span>
  );
}

function Row({ project }: { project: AwaitingApprovalProject }) {
  return (
    <Link
      href={`/projects/${project.id}?tab=budget`}
      className="group flex items-center gap-3 rounded-md border bg-card px-3 py-3 transition-colors hover:bg-muted/50"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{project.customer_name ?? '—'}</span>
          <span className="text-muted-foreground text-xs">·</span>
          <span className="truncate text-sm text-muted-foreground">{project.name}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Send className="size-3" />
          <span>
            Sent{' '}
            {project.days_since_sent === 0
              ? 'today'
              : project.days_since_sent === 1
                ? 'yesterday'
                : `${project.days_since_sent} days ago`}
          </span>
          <span>·</span>
          <ViewBadge project={project} />
        </div>
      </div>
      <div className="flex items-center gap-2 text-right">
        <span className="font-medium tabular-nums">{formatCurrency(project.total_cents)}</span>
        <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}

type Props = {
  projects: AwaitingApprovalProject[];
  variant?: 'compact' | 'full';
  limit?: number;
};

export function AwaitingApprovalList({ projects, variant = 'compact', limit = 5 }: Props) {
  if (projects.length === 0) {
    if (variant === 'full') {
      return (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No estimates out for approval right now. Send one from a project&apos;s Estimate tab.
          </CardContent>
        </Card>
      );
    }
    // Compact variant hides itself when empty — dashboard stays clean.
    return null;
  }

  const visible = variant === 'compact' ? projects.slice(0, limit) : projects;
  const hiddenCount = variant === 'compact' ? Math.max(0, projects.length - limit) : 0;

  if (variant === 'full') {
    return (
      <div className="flex flex-col gap-2">
        {visible.map((p) => (
          <Row key={p.id} project={p} />
        ))}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-baseline justify-between gap-2">
          <div>
            <CardTitle className="text-base">Awaiting approval</CardTitle>
            <CardDescription>
              {projects.length} estimate{projects.length === 1 ? '' : 's'} waiting on the customer
            </CardDescription>
          </div>
          {hiddenCount > 0 ? (
            <Link
              href="/projects?view=awaiting_approval"
              className="text-xs text-muted-foreground hover:underline"
            >
              View all ({projects.length}) →
            </Link>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {visible.map((p) => (
          <Row key={p.id} project={p} />
        ))}
      </CardContent>
    </Card>
  );
}
