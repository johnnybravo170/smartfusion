'use client';

/**
 * Versions dropdown — a small chip in the project page header that
 * lists every signed version of the project's scope (estimate v1 +
 * each applied change order). Click a version → read-only modal with
 * the frozen scope (cost lines + budget categories + total) from that
 * moment.
 *
 * Snapshot-backed versions show the full read-only viewer. Legacy
 * versions (pre-snapshot table) show metadata + a notice that the
 * frozen state isn't available.
 */

import { ChevronDown, History, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { ProjectScopeSnapshot } from '@/lib/db/queries/project-scope-snapshots';
import type { ProjectVersionListItem } from '@/lib/db/queries/project-versions';
import { formatCurrency } from '@/lib/pricing/calculator';

export function VersionsDropdownClient({
  projectId,
  versions,
}: {
  projectId: string;
  versions: ProjectVersionListItem[];
}) {
  const [activeVersion, setActiveVersion] = useState<ProjectVersionListItem | null>(null);
  const [snapshot, setSnapshot] = useState<ProjectScopeSnapshot | null>(null);
  const [pending, startTransition] = useTransition();

  // Auto-open the dropdown when navigated with ?versions=open. Used by
  // the "See history" link on the applied-COs banner. Once consumed,
  // strip the param so the dropdown doesn't re-fire on tab switches.
  const router = useRouter();
  const searchParams = useSearchParams();
  const [popoverOpen, setPopoverOpen] = useState(false);
  useEffect(() => {
    if (searchParams.get('versions') === 'open') {
      setPopoverOpen(true);
      const sp = new URLSearchParams(searchParams.toString());
      sp.delete('versions');
      router.replace(sp.toString() ? `?${sp.toString()}` : '?', { scroll: false });
    }
  }, [searchParams, router]);

  function openVersion(v: ProjectVersionListItem) {
    setActiveVersion(v);
    setSnapshot(null);
    if (!v.snapshot_id) return;
    startTransition(async () => {
      const res = await fetch(`/api/project-snapshots/${v.snapshot_id}`);
      if (res.ok) {
        const data = (await res.json()) as ProjectScopeSnapshot;
        setSnapshot(data);
      }
    });
  }

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <History className="size-3.5" />
            Versions
            <ChevronDown className="size-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-1" align="end">
          <p className="px-2 pt-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Signed versions
          </p>
          <ul className="flex flex-col">
            {versions.map((v) => (
              <li key={`v${v.version_number}-${v.signed_at}`}>
                <button
                  type="button"
                  onClick={() => openVersion(v)}
                  className="flex w-full flex-col rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{v.label}</span>
                    {v.total_cents !== null ? (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {formatCurrency(v.total_cents)}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    Signed{' '}
                    {new Date(v.signed_at).toLocaleDateString('en-CA', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                    {v.signed_by_name ? ` · ${v.signed_by_name}` : ''}
                    {v.snapshot_id ? '' : ' · legacy'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>

      <Dialog
        open={activeVersion !== null}
        onOpenChange={(o) => {
          if (!o) {
            setActiveVersion(null);
            setSnapshot(null);
          }
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{activeVersion?.label ?? 'Version'}</DialogTitle>
            <DialogDescription>
              {activeVersion ? (
                <>
                  Signed{' '}
                  {new Date(activeVersion.signed_at).toLocaleDateString('en-CA', {
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                  {activeVersion.signed_by_name ? ` by ${activeVersion.signed_by_name}` : ''}
                  {activeVersion.total_cents !== null
                    ? ` · ${formatCurrency(activeVersion.total_cents)}`
                    : ''}
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          {activeVersion && !activeVersion.snapshot_id ? (
            <div className="rounded-md border border-amber-200 bg-amber-50/40 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/20">
              <p className="font-medium text-amber-900 dark:text-amber-100">
                Snapshot not available
              </p>
              <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">
                This version was signed before frozen-scope history was added to HeyHenry. The event
                itself stays in the audit trail, but the line-by-line state at signing isn&rsquo;t
                recoverable.
              </p>
              {activeVersion.change_order_id ? (
                <Link
                  href={`/projects/${projectId}/change-orders/${activeVersion.change_order_id}`}
                  className="mt-3 inline-flex items-center text-xs font-medium underline"
                >
                  Open the change order →
                </Link>
              ) : null}
            </div>
          ) : pending || !snapshot ? (
            <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading frozen scope…
            </div>
          ) : (
            <SnapshotViewer snapshot={snapshot} />
          )}

          <DialogFooter>
            {activeVersion?.change_order_id ? (
              <Button asChild variant="outline" size="sm">
                <Link
                  href={`/projects/${projectId}/change-orders/${activeVersion.change_order_id}`}
                >
                  Open change order
                </Link>
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={() => {
                setActiveVersion(null);
                setSnapshot(null);
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SnapshotViewer({ snapshot }: { snapshot: ProjectScopeSnapshot }) {
  const linesByCategoryId = new Map<string, typeof snapshot.cost_lines>();
  for (const l of snapshot.cost_lines) {
    const k = l.budget_category_id ?? '__uncategorized__';
    const arr = linesByCategoryId.get(k) ?? [];
    arr.push(l);
    linesByCategoryId.set(k, arr);
  }

  const categories = snapshot.budget_categories;

  return (
    <div className="max-h-[60vh] space-y-4 overflow-y-auto">
      {categories.length === 0 && snapshot.cost_lines.length === 0 ? (
        <p className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
          No line items or buckets at signing.
        </p>
      ) : null}

      {categories.map((cat) => {
        const lines = linesByCategoryId.get(cat.id) ?? [];
        const subtotal = lines.reduce((s, l) => s + (l.line_price_cents ?? 0), 0);
        return (
          <div key={cat.id} className="rounded-md border">
            <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
              <span className="text-sm font-medium">{cat.name}</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {formatCurrency(subtotal)} of {formatCurrency(cat.estimate_cents)}
              </span>
            </div>
            {lines.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">No line items</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id} className="border-b last:border-0">
                      <td className="px-3 py-1.5">{l.label}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                        {l.qty} {l.unit}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                        {formatCurrency(l.unit_price_cents)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-medium">
                        {formatCurrency(l.line_price_cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}

      {(linesByCategoryId.get('__uncategorized__') ?? []).length > 0 ? (
        <div className="rounded-md border">
          <div className="border-b bg-muted/40 px-3 py-2 text-sm font-medium">Unassigned</div>
          <table className="w-full text-sm">
            <tbody>
              {linesByCategoryId.get('__uncategorized__')?.map((l) => (
                <tr key={l.id} className="border-b last:border-0">
                  <td className="px-3 py-1.5">{l.label}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                    {l.qty} {l.unit}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                    {formatCurrency(l.unit_price_cents)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-medium">
                    {formatCurrency(l.line_price_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="flex items-center justify-between rounded-md border-2 border-foreground/10 bg-muted/20 px-3 py-2 text-sm font-semibold">
        <span>Total</span>
        <span className="tabular-nums">{formatCurrency(snapshot.total_cents)}</span>
      </div>
    </div>
  );
}
