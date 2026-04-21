'use client';

/**
 * Quote PDF import flow for /projects/new.
 *
 * Stages:
 *   idle     → drop a PDF (or click "Enter manually" to bypass)
 *   parsing  → Gemini is extracting
 *   review   → editable form seeded from the extraction; submit commits
 */

import { ArrowLeft, FileText, Loader2, Plus, Trash2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import {
  type CustomerMatch,
  commitQuoteImportAction,
  searchCustomerMatchesAction,
} from '@/server/actions/commit-quote-import';
import { parseQuotePdfAction, type QuoteExtraction } from '@/server/actions/parse-quote-pdf';

type Stage = 'idle' | 'parsing' | 'review';

type BucketDraft = {
  id: string;
  section: string;
  name: string;
  description: string;
  estimate_cents: number;
  display_order: number;
};

let __bucketSeq = 0;
function newBucketId(): string {
  __bucketSeq += 1;
  return `b${__bucketSeq}`;
}

type ReviewState = {
  customer: {
    /** If set → attach to this existing customer, ignore name/address/type. */
    attachedCustomerId: string | null;
    type: 'residential' | 'commercial' | 'agent';
    name: string;
    address: string;
  };
  project: {
    name: string;
    description: string;
    start_date: string;
    management_fee_rate: number;
  };
  buckets: BucketDraft[];
  // meta from the quote, shown for sanity-check only
  meta: { subtotal_cents: number | null; tax_cents: number | null; total_cents: number | null };
  flags: string[];
};

function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

function dollarsToCents(v: string): number {
  const n = Number.parseFloat(v.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function extractionToState(e: QuoteExtraction): ReviewState {
  return {
    customer: {
      attachedCustomerId: null,
      type: 'residential',
      name: e.customer.name ?? '',
      address: e.customer.address ?? '',
    },
    project: {
      name: e.project.name ?? '',
      description: '',
      start_date: e.project.quote_date ?? '',
      management_fee_rate: e.project.management_fee_rate ?? 0.12,
    },
    buckets: e.buckets.map((b, i) => ({
      id: newBucketId(),
      section: b.section,
      name: b.name,
      description: b.description ?? '',
      estimate_cents: b.estimate_cents ?? 0,
      display_order: b.display_order ?? i,
    })),
    meta: {
      subtotal_cents: e.project.subtotal_cents ?? null,
      tax_cents: e.project.tax_cents ?? null,
      total_cents: e.project.total_cents ?? null,
    },
    flags: e.uncertainty_flags ?? [],
  };
}

type QuoteImportFlowProps = {
  /**
   * Rendered alongside the dropzone in the idle state. Typically the manual
   * ProjectForm so the operator can start from scratch without ever touching
   * the importer. Hidden when a PDF is being parsed or reviewed.
   */
  manualFormSlot: React.ReactNode;
};

export function QuoteImportFlow({ manualFormSlot }: QuoteImportFlowProps) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('idle');
  const [state, setState] = useState<ReviewState | null>(null);
  const [matches, setMatches] = useState<CustomerMatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isCommitting, startCommit] = useTransition();

  async function handleFile(file: File) {
    setError(null);
    if (file.type !== 'application/pdf') {
      setError('Please drop a PDF file.');
      return;
    }
    setStage('parsing');
    const fd = new FormData();
    fd.set('file', file);
    const result = await parseQuotePdfAction(fd);
    if (!result.ok) {
      setError(result.error);
      setStage('idle');
      return;
    }
    setState(extractionToState(result.extraction));
    setStage('review');
    // Fire-and-forget: fuzzy-match the extracted name against existing
    // customers so the operator can attach instead of duplicating.
    const extractedName = result.extraction.customer.name ?? '';
    if (extractedName.trim()) {
      searchCustomerMatchesAction(extractedName)
        .then(setMatches)
        .catch(() => setMatches([]));
    }
  }

  function updateBucket(i: number, patch: Partial<BucketDraft>) {
    setState((s) => {
      if (!s) return s;
      const buckets = s.buckets.map((b, idx) => (idx === i ? { ...b, ...patch } : b));
      return { ...s, buckets };
    });
  }

  function removeBucket(i: number) {
    setState((s) => (s ? { ...s, buckets: s.buckets.filter((_, idx) => idx !== i) } : s));
  }

  function addBucket() {
    setState((s) => {
      if (!s) return s;
      return {
        ...s,
        buckets: [
          ...s.buckets,
          {
            id: newBucketId(),
            section: s.buckets.at(-1)?.section ?? '',
            name: '',
            description: '',
            estimate_cents: 0,
            display_order: s.buckets.length,
          },
        ],
      };
    });
  }

  function commit() {
    if (!state) return;
    setError(null);
    startCommit(async () => {
      const result = await commitQuoteImportAction({
        customer: {
          id: state.customer.attachedCustomerId ?? undefined,
          type: state.customer.type,
          name: state.customer.name,
          address: state.customer.address || undefined,
        },
        project: {
          name: state.project.name,
          description: state.project.description || undefined,
          start_date: state.project.start_date || undefined,
          management_fee_rate: state.project.management_fee_rate,
        },
        buckets: state.buckets,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success('Project created from quote');
      router.push(`/projects/${result.projectId}`);
    });
  }

  const bucketsTotal = state?.buckets.reduce((sum, b) => sum + b.estimate_cents, 0) ?? 0;

  if (stage === 'idle') {
    return (
      <div className="grid gap-8 md:grid-cols-[1fr_320px]">
        <div className="min-w-0">{manualFormSlot}</div>
        <aside className="space-y-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Or start from a quote
          </div>
          <button
            type="button"
            onClick={() => {
              const el = document.getElementById('quote-pdf-input') as HTMLInputElement | null;
              el?.click();
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) void handleFile(f);
            }}
            className={`flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center transition ${
              isDragging
                ? 'border-primary bg-primary/5'
                : 'border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/30'
            }`}
          >
            <Upload className="size-6 text-muted-foreground" />
            <div className="text-sm font-medium">Drop a quote PDF</div>
            <div className="text-xs text-muted-foreground">
              Henry will pull out the customer, scope, and line items so you can review and commit
              in one step.
            </div>
            <input
              id="quote-pdf-input"
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
            />
          </button>
          {error ? (
            <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
          ) : null}
        </aside>
      </div>
    );
  }

  if (stage === 'parsing') {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border p-12">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
        <div className="text-sm font-medium">Reading the quote…</div>
        <div className="text-xs text-muted-foreground">This usually takes 10–20 seconds.</div>
      </div>
    );
  }

  if (!state) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
        <FileText className="size-4" />
        Review what Henry pulled from the quote. Edit anything, then create the project.
        <button
          type="button"
          onClick={() => {
            setState(null);
            setStage('idle');
          }}
          className="ml-auto inline-flex items-center gap-1 hover:text-foreground"
        >
          <ArrowLeft className="size-3" /> Start over
        </button>
      </div>

      {state.flags.length > 0 ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="font-medium">Flagged for review</div>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {state.flags.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Customer</h2>

        {matches.length > 0 && !state.customer.attachedCustomerId ? (
          <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm">
            <div className="mb-2 font-medium text-blue-900">
              {matches.length === 1
                ? 'This might be an existing customer.'
                : 'Possible existing customers.'}
            </div>
            <ul className="space-y-1">
              {matches.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2">
                  <span className="text-blue-900">
                    {m.name}
                    <span className="ml-2 text-xs text-blue-700">
                      {m.type}
                      {m.city ? ` · ${m.city}` : ''} · added{' '}
                      {new Date(m.created_at).toLocaleDateString()}
                    </span>
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setState((s) =>
                        s
                          ? {
                              ...s,
                              customer: { ...s.customer, attachedCustomerId: m.id, name: m.name },
                            }
                          : s,
                      )
                    }
                  >
                    Attach
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {state.customer.attachedCustomerId ? (
          <div className="flex items-center justify-between rounded-md border border-blue-300 bg-blue-50 p-3 text-sm">
            <div className="text-blue-900">
              Attaching to <span className="font-medium">{state.customer.name}</span>. New project
              will land under this customer; no duplicate will be created.
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                setState((s) =>
                  s ? { ...s, customer: { ...s.customer, attachedCustomerId: null } } : s,
                )
              }
            >
              Create new instead
            </Button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_160px] gap-3">
              <div>
                <Label>Name</Label>
                <Input
                  value={state.customer.name}
                  onChange={(e) =>
                    setState({ ...state, customer: { ...state.customer, name: e.target.value } })
                  }
                />
              </div>
              <div>
                <Label>Type</Label>
                <Select
                  value={state.customer.type}
                  onValueChange={(v) =>
                    setState({
                      ...state,
                      customer: { ...state.customer, type: v as ReviewState['customer']['type'] },
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="residential">Residential</SelectItem>
                    <SelectItem value="commercial">Commercial</SelectItem>
                    <SelectItem value="agent">Agent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Address</Label>
              <Input
                value={state.customer.address}
                onChange={(e) =>
                  setState({ ...state, customer: { ...state.customer, address: e.target.value } })
                }
              />
            </div>
          </>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Project</h2>
        <div>
          <Label>Name</Label>
          <Input
            value={state.project.name}
            onChange={(e) =>
              setState({ ...state, project: { ...state.project, name: e.target.value } })
            }
          />
        </div>
        <div>
          <Label>Description (optional)</Label>
          <Textarea
            rows={2}
            value={state.project.description}
            onChange={(e) =>
              setState({ ...state, project: { ...state.project, description: e.target.value } })
            }
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Quote date</Label>
            <Input
              type="date"
              value={state.project.start_date}
              onChange={(e) =>
                setState({
                  ...state,
                  project: { ...state.project, start_date: e.target.value },
                })
              }
            />
          </div>
          <div>
            <Label>Management fee (%)</Label>
            <div className="relative">
              <Input
                type="number"
                step="0.01"
                min="0"
                max="100"
                className="pr-8"
                value={(state.project.management_fee_rate * 100).toFixed(2)}
                onChange={(e) => {
                  const pct = Number.parseFloat(e.target.value);
                  setState({
                    ...state,
                    project: {
                      ...state.project,
                      management_fee_rate: Number.isFinite(pct) ? pct / 100 : 0,
                    },
                  });
                }}
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
                %
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Cost buckets</h2>
          <Button type="button" variant="outline" size="sm" onClick={addBucket}>
            <Plus className="size-3.5" /> Add row
          </Button>
        </div>
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[20%]">Section</TableHead>
                <TableHead className="w-[20%]">Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-[120px] text-right">Estimate</TableHead>
                <TableHead className="w-[40px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.buckets.map((b, i) => (
                <TableRow key={b.id}>
                  <TableCell>
                    <Input
                      value={b.section}
                      onChange={(e) => updateBucket(i, { section: e.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={b.name}
                      onChange={(e) => updateBucket(i, { name: e.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    <Textarea
                      rows={1}
                      className="min-h-[36px] resize-y"
                      value={b.description}
                      onChange={(e) => updateBucket(i, { description: e.target.value })}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Input
                      className="text-right"
                      value={centsToDollars(b.estimate_cents)}
                      onChange={(e) =>
                        updateBucket(i, { estimate_cents: dollarsToCents(e.target.value) })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeBucket(i)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="flex flex-col items-end gap-1 text-sm">
          <div>
            <span className="text-muted-foreground">Buckets total: </span>
            <span className="font-medium">${centsToDollars(bucketsTotal)}</span>
          </div>
          {state.meta.subtotal_cents != null ? (
            <div
              className={
                state.meta.subtotal_cents === bucketsTotal
                  ? 'text-xs text-muted-foreground'
                  : 'text-xs text-amber-600'
              }
            >
              Quote subtotal: ${centsToDollars(state.meta.subtotal_cents)}
              {state.meta.subtotal_cents !== bucketsTotal ? ' (mismatch)' : ''}
            </div>
          ) : null}
          {state.meta.total_cents != null ? (
            <div className="text-xs text-muted-foreground">
              Quote total (w/ fee + tax): ${centsToDollars(state.meta.total_cents)}
            </div>
          ) : null}
        </div>
      </section>

      {error ? (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            setState(null);
            setStage('idle');
          }}
        >
          Cancel
        </Button>
        <Button onClick={commit} disabled={isCommitting}>
          {isCommitting ? <Loader2 className="size-4 animate-spin" /> : null}
          Create project
        </Button>
      </div>
    </div>
  );
}
