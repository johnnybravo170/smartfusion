'use client';

/**
 * AI-assisted scope scaffold generator on the empty Budget page.
 *
 * Operator types a brief description; Henry drafts a sectioned
 * scaffold (buckets + lines, no prices). Operator reviews and applies
 * — never auto-applied. Per the rollup: typed-first, voice/photo
 * input layers on later.
 */

import { Loader2, Sparkles, Wand2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import type { StarterTemplate } from '@/data/starter-templates/types';
import { cn } from '@/lib/utils';
import { applyScaffoldAction, generateScaffoldAction } from '@/server/actions/scope-scaffold';

type DetailLevel = 'quick' | 'standard' | 'detailed';

const DETAIL_OPTIONS: Array<{ value: DetailLevel; label: string; hint: string }> = [
  { value: 'quick', label: 'Quick', hint: '~5 lines · top-level scope' },
  { value: 'standard', label: 'Standard', hint: '~15 lines · typical breakdown' },
  { value: 'detailed', label: 'Detailed', hint: '~40 lines · every cost broken out' },
];

export function ScopeScaffoldGenerator({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [detailLevel, setDetailLevel] = useState<DetailLevel>('standard');
  const [scaffold, setScaffold] = useState<StarterTemplate | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setDescription('');
    setDetailLevel('standard');
    setScaffold(null);
  }

  function generate() {
    startTransition(async () => {
      const res = await generateScaffoldAction({
        description,
        detailLevel,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setScaffold(res.scaffold);
    });
  }

  function apply() {
    if (!scaffold) return;
    startTransition(async () => {
      const res = await applyScaffoldAction({ projectId, scaffold });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Seeded ${res.bucketCount} buckets · ${res.lineCount} line items.`);
      setOpen(false);
      reset();
    });
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-blue-200 bg-blue-50/40 px-3 py-3 text-sm dark:border-blue-900 dark:bg-blue-950/30">
        <div className="flex items-center gap-2">
          <Wand2 className="size-4 text-blue-700 dark:text-blue-300" />
          <div>
            <p className="font-medium text-blue-900 dark:text-blue-100">
              Or describe the job and let Henry draft it
            </p>
            <p className="text-xs text-blue-800/80 dark:text-blue-200/80">
              Type a couple sentences — Henry returns buckets + line items, no prices.
            </p>
          </div>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Sparkles className="size-3.5" />
          Describe the job
        </Button>
      </div>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Describe the job</DialogTitle>
            <DialogDescription>
              Plain language, like you&rsquo;d tell a buddy. Henry returns buckets + line items (no
              prices). You review, edit, accept.
            </DialogDescription>
          </DialogHeader>

          {!scaffold ? (
            <div className="space-y-3">
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Downstairs bathroom reno — 5x8, full demo, new tile, vanity, toilet, fixtures, fan."
                rows={5}
                disabled={pending}
                autoFocus
              />

              <div className="space-y-1.5">
                <p className="text-xs font-medium">Detail level</p>
                <div className="flex flex-wrap gap-2">
                  {DETAIL_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => setDetailLevel(o.value)}
                      disabled={pending}
                      className={cn(
                        'rounded-md border px-3 py-1.5 text-left text-xs transition',
                        detailLevel === o.value
                          ? 'border-foreground bg-foreground text-background'
                          : 'hover:bg-muted',
                      )}
                    >
                      <div className="font-medium">{o.label}</div>
                      <div
                        className={
                          detailLevel === o.value
                            ? 'text-[10px] opacity-80'
                            : 'text-[10px] text-muted-foreground'
                        }
                      >
                        {o.hint}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <ScaffoldPreview scaffold={scaffold} />
          )}

          <DialogFooter>
            {!scaffold ? (
              <>
                <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={generate}
                  disabled={pending || description.trim().length < 10}
                >
                  {pending ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" /> Drafting&hellip;
                    </>
                  ) : (
                    <>
                      <Sparkles className="size-3.5" /> Draft scaffold
                    </>
                  )}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setScaffold(null)}
                  disabled={pending}
                >
                  Back
                </Button>
                <Button size="sm" onClick={apply} disabled={pending}>
                  {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Use this scaffold
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ScaffoldPreview({ scaffold }: { scaffold: StarterTemplate }) {
  if (scaffold.buckets.length === 0) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50/40 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/20">
        <p className="font-medium text-amber-900 dark:text-amber-100">Need a bit more detail</p>
        <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">{scaffold.description}</p>
      </div>
    );
  }
  const totalLines = scaffold.buckets.reduce((s, b) => s + b.lines.length, 0);
  return (
    <div className="space-y-2">
      <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
        <p className="font-medium">{scaffold.label}</p>
        <p className="text-muted-foreground">{scaffold.description}</p>
        <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          {scaffold.buckets.length} buckets · {totalLines} line items · prices empty
        </p>
      </div>
      <ul className="max-h-[40vh] space-y-2 overflow-y-auto pr-1">
        {scaffold.buckets.map((b) => (
          <li key={b.name} className="rounded-md border">
            <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-1.5">
              <span className="text-sm font-medium">{b.name}</span>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {b.section}
              </span>
            </div>
            {b.lines.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">No lines</p>
            ) : (
              <ul className="divide-y text-sm">
                {b.lines.map((l) => (
                  <li
                    key={`${b.name}-${l.label}`}
                    className="flex items-center justify-between px-3 py-1.5"
                  >
                    <span className="flex-1">{l.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {l.qty} {l.unit} · {l.category}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
