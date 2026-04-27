'use client';

/**
 * Sortable table for the Projects list. Click a column header to sort;
 * click again to flip direction. Sort state lives in component state —
 * no URL round-trip, no server re-fetch (the list is capped at 200 rows
 * upstream, so client-side is plenty).
 *
 * Status sort uses a rank from most-active → most-terminal so "sorting
 * by status" feels like "show me what's alive first."
 */

import { ChevronDown, ChevronsUpDown, ChevronUp } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { CloneProjectDialog } from '@/components/features/projects/clone-project-dialog';
import { ProjectNameEditor } from '@/components/features/projects/project-name-editor';
import { ProjectStatusBadge } from '@/components/features/projects/project-status-badge';
import { cn } from '@/lib/utils';
import type { LifecycleStage } from '@/lib/validators/project';

type ProjectRow = {
  id: string;
  name: string;
  lifecycle_stage: LifecycleStage;
  start_date: string | null;
  // Derived: cost-to-cost capped at 99 for active, 100 for complete, 0 for cancelled.
  work_status_pct: number;
  // Derived: uncapped cost / est revenue. >100 = over budget.
  cost_burn_pct: number;
  customer: { id: string; name: string } | null;
};

type CustomerOption = { id: string; name: string };

type SortKey = 'name' | 'customer' | 'status' | 'start' | 'complete';
type SortDir = 'asc' | 'desc';

// Active-first ordering for the Status column.
const STAGE_RANK: Record<LifecycleStage, number> = {
  active: 0,
  awaiting_approval: 1,
  planning: 2,
  on_hold: 3,
  declined: 4,
  complete: 5,
  cancelled: 6,
};

export function ProjectsTable({
  projects,
  customerOptions,
}: {
  projects: ProjectRow[];
  customerOptions: CustomerOption[];
}) {
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const sorted = [...projects].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    switch (sortKey) {
      case 'name':
        return a.name.localeCompare(b.name) * dir;
      case 'customer':
        return (a.customer?.name ?? '').localeCompare(b.customer?.name ?? '') * dir;
      case 'status':
        return (STAGE_RANK[a.lifecycle_stage] - STAGE_RANK[b.lifecycle_stage]) * dir;
      case 'start': {
        // Projects without a start_date sort last regardless of direction
        // — "no date" isn't meaningfully earlier or later than anything.
        if (!a.start_date && !b.start_date) return 0;
        if (!a.start_date) return 1;
        if (!b.start_date) return -1;
        return a.start_date.localeCompare(b.start_date) * dir;
      }
      case 'complete':
        return (a.work_status_pct - b.work_status_pct) * dir;
      default:
        return 0;
    }
  });

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <SortHeader
              label="Project"
              sortKey="name"
              activeKey={sortKey}
              dir={sortDir}
              onClick={toggleSort}
            />
            <SortHeader
              label="Customer"
              sortKey="customer"
              activeKey={sortKey}
              dir={sortDir}
              onClick={toggleSort}
            />
            <SortHeader
              label="Status"
              sortKey="status"
              activeKey={sortKey}
              dir={sortDir}
              onClick={toggleSort}
            />
            <SortHeader
              label="Start"
              sortKey="start"
              activeKey={sortKey}
              dir={sortDir}
              onClick={toggleSort}
            />
            <SortHeader
              label="Complete"
              sortKey="complete"
              activeKey={sortKey}
              dir={sortDir}
              onClick={toggleSort}
              align="right"
            />
            <th className="w-px px-2 py-3" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => (
            <tr key={p.id} className="group border-b last:border-0 hover:bg-muted/30">
              <td className="px-4 py-3">
                <span className="inline-flex items-center gap-1">
                  <Link href={`/projects/${p.id}`} className="font-medium hover:underline">
                    {p.name}
                  </Link>
                  <ProjectNameEditor projectId={p.id} name={p.name} variant="inline" />
                </span>
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {p.customer ? (
                  <Link href={`/contacts/${p.customer.id}`} className="hover:underline">
                    {p.customer.name}
                  </Link>
                ) : (
                  '—'
                )}
              </td>
              <td className="px-4 py-3">
                <ProjectStatusBadge stage={p.lifecycle_stage} />
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {p.start_date
                  ? new Date(p.start_date).toLocaleDateString('en-CA', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })
                  : '—'}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                <div>{p.work_status_pct}%</div>
                <div
                  className={cn(
                    'text-xs',
                    p.cost_burn_pct > 100 ? 'text-destructive' : 'text-muted-foreground',
                  )}
                  title="Cost burn: cost incurred / estimated revenue"
                >
                  burn {p.cost_burn_pct}%
                </div>
              </td>
              <td className="px-2 py-3 text-right">
                <CloneProjectDialog
                  projectId={p.id}
                  projectName={p.name}
                  defaultCustomerId={p.customer?.id ?? null}
                  customers={customerOptions}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  activeKey,
  dir,
  onClick,
  align = 'left',
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  dir: SortDir;
  onClick: (key: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const isActive = activeKey === sortKey;
  const Icon = !isActive ? ChevronsUpDown : dir === 'asc' ? ChevronUp : ChevronDown;
  return (
    <th className={cn('px-4 py-3 font-medium', align === 'right' ? 'text-right' : 'text-left')}>
      <button
        type="button"
        onClick={() => onClick(sortKey)}
        className={cn(
          'inline-flex items-center gap-1 hover:text-foreground',
          align === 'right' && 'flex-row-reverse',
          isActive ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        <span>{label}</span>
        <Icon className="size-3.5 opacity-70" />
      </button>
    </th>
  );
}
