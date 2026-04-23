'use client';

/**
 * Universal project drop zone.
 *
 * Click "Add to project" → modal with a drop area. Drop screenshots,
 * reference photos, sketches. Henry parses against the project's
 * existing buckets and returns a list of suggested additions. Operator
 * accepts or trims, then applies.
 *
 * V1 scope: images only. PDFs / receipts / audio land in later phases.
 */

import { FileText, Loader2, Sparkles, Upload, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { AugmentResult } from '@/lib/ai/intake-augment-prompt';
import { resizeImage } from '@/lib/storage/resize-image';
import {
  applyProjectAugmentAction,
  parseProjectAugmentAction,
} from '@/server/actions/intake-augment';
import { fetchSharedFileAction } from '@/server/actions/share-intake';
import { SubQuoteForm } from './sub-quote-form';

type StagedFile = { file: File; previewUrl: string; key: string };

const RESIZE_THRESHOLD_BYTES = 2 * 1024 * 1024; // 2MB

/** Resize images larger than 2MB; PDFs and small images pass through. */
async function shrinkIfNeeded(file: File): Promise<File> {
  if (file.type === 'application/pdf') return file;
  if (!file.type.startsWith('image/')) return file;
  if (file.size <= RESIZE_THRESHOLD_BYTES) return file;
  try {
    const blob = await resizeImage(file, { maxDimension: 2048, quality: 0.85 });
    const newName = file.name.replace(/\.(heic|heif|png|webp)$/i, '.jpg');
    return new File([blob], newName || 'image.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

type Bucket = { id: string; name: string; section: 'interior' | 'exterior' | 'general' };

export function ProjectIntakeZone({
  projectId,
  buckets = [],
}: {
  projectId: string;
  /** Project's existing cost buckets. Used to resolve AI sub-quote
   * allocation bucket-names back to real IDs before handing off to the
   * sub-quote review dialog. */
  buckets?: Bucket[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  const [staged, setStaged] = useState<StagedFile[]>([]);

  // iOS shortcut deep link: `?intake=open` auto-expands the zone on load.
  // Web Share Target: `?share=<token>` means a file was posted to
  // /share/receive, stashed in storage, and this tab should pull it in
  // as a staged file (exactly as if the operator had dropped it on the
  // drop area).
  // Mount-only: if the user lands with either param we respect them once;
  // later changes shouldn't re-trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only behaviour is deliberate.
  useEffect(() => {
    const shouldOpen = searchParams.get('intake') === 'open';
    const shareToken = searchParams.get('share');
    const shareName = searchParams.get('share_name') ?? undefined;
    if (!shouldOpen && !shareToken) return;
    if (shouldOpen) setOpen(true);

    // Pull the shared file (if any) into staged.
    if (shareToken) {
      (async () => {
        const result = await fetchSharedFileAction({ token: shareToken, filename: shareName });
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        // Convert base64 back to a File the drop-area pipeline already
        // knows how to handle.
        const bytes = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes as unknown as BlobPart], { type: result.contentType });
        const file = new File([blob], result.filename, { type: result.contentType });
        setStaged((s) => [
          ...s,
          {
            file,
            previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : '',
            key: `${Date.now()}-shared-${Math.random().toString(36).slice(2, 8)}`,
          },
        ]);
        setOpen(true);
      })();
    }

    // Strip the share-related params so a refresh doesn't re-fetch the
    // (now-deleted) file.
    const sp = new URLSearchParams(searchParams.toString());
    sp.delete('intake');
    sp.delete('share');
    sp.delete('share_name');
    sp.delete('share_text');
    sp.delete('share_url');
    const next = sp.toString();
    router.replace(next ? `?${next}` : '?', { scroll: false });
  }, []);
  const [suggestions, setSuggestions] = useState<AugmentResult | null>(null);
  // Per-suggestion include flags so operator can trim.
  const [existingBuckets, setExistingBuckets] = useState<string[]>([]);
  const [includeBuckets, setIncludeBuckets] = useState<boolean[]>([]);
  const [includeLines, setIncludeLines] = useState<boolean[]>([]);
  const [includeBills, setIncludeBills] = useState<boolean[]>([]);
  const [includeExpenses, setIncludeExpenses] = useState<boolean[]>([]);
  // Per-line bucket selection: null = use AI suggestion, string = operator override
  const [lineBucketSelections, setLineBucketSelections] = useState<string[]>([]);
  // Per-bill / per-expense bucket overrides. Empty string "" = deliberately
  // unassigned (valid — bill/expense can carry no bucket). string = operator
  // chose that bucket name. Parallel arrays, one slot per item.
  const [billBucketSelections, setBillBucketSelections] = useState<string[]>([]);
  const [expenseBucketSelections, setExpenseBucketSelections] = useState<string[]>([]);
  // Bill ↔ expense reclassification. If a bill gets marked as expense, at
  // apply time it's moved to the new_expenses payload (amount + GST merged
  // into one amount_cents). If an expense gets marked as bill, it's moved
  // to new_bills (gst_cents defaults to 0; operator can edit after).
  const [billReclassifiedAsExpense, setBillReclassifiedAsExpense] = useState<boolean[]>([]);
  const [expenseReclassifiedAsBill, setExpenseReclassifiedAsBill] = useState<boolean[]>([]);
  const [includeAddendum, setIncludeAddendum] = useState(true);
  const [includeSignals, setIncludeSignals] = useState(true);
  const [isParsing, startParsing] = useTransition();
  const [isApplying, startApplying] = useTransition();
  // Indices of new_sub_quotes that have already been saved via the review
  // dialog — removed from the list so the operator doesn't double-save.
  const [savedSubQuoteIndexes, setSavedSubQuoteIndexes] = useState<Set<number>>(new Set());
  // The sub quote currently being reviewed (index into suggestions.new_sub_quotes).
  const [reviewingSubQuoteIndex, setReviewingSubQuoteIndex] = useState<number | null>(null);

  const reset = useCallback(() => {
    for (const s of staged) {
      if (s.previewUrl) URL.revokeObjectURL(s.previewUrl);
    }
    setStaged([]);
    setSuggestions(null);
    setExistingBuckets([]);
    setLineBucketSelections([]);
    setBillBucketSelections([]);
    setExpenseBucketSelections([]);
    setBillReclassifiedAsExpense([]);
    setExpenseReclassifiedAsBill([]);
    setIncludeBills([]);
    setSavedSubQuoteIndexes(new Set());
    setReviewingSubQuoteIndex(null);
  }, [staged]);

  function addFiles(files: FileList | File[]) {
    const next = Array.from(files)
      .filter((f) => f.type.startsWith('image/') || f.type === 'application/pdf')
      .map((f) => ({
        file: f,
        previewUrl: f.type.startsWith('image/') ? URL.createObjectURL(f) : '',
        key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      }));
    setStaged((s) => [...s, ...next]);
  }

  function removeStaged(key: string) {
    setStaged((s) => {
      const target = s.find((x) => x.key === key);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return s.filter((x) => x.key !== key);
    });
  }

  function handleParse() {
    if (staged.length === 0) {
      toast.error('Drop at least one image first.');
      return;
    }
    startParsing(async () => {
      const fd = new FormData();
      fd.set('projectId', projectId);
      for (const s of staged) {
        const shrunk = await shrinkIfNeeded(s.file);
        fd.append('images', shrunk);
      }
      const res = await parseProjectAugmentAction(fd);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setSuggestions(res.suggestions);
      setExistingBuckets(res.existingBuckets);
      setIncludeBuckets(res.suggestions.new_buckets.map(() => true));
      setIncludeLines(res.suggestions.new_lines.map(() => true));
      setIncludeBills((res.suggestions.new_bills ?? []).map(() => true));
      setIncludeExpenses((res.suggestions.new_expenses ?? []).map(() => true));
      setIncludeAddendum(!!res.suggestions.description_addendum);
      setIncludeSignals(true);
      setLineBucketSelections(res.suggestions.new_lines.map((l) => l.bucket_name));
      setBillBucketSelections((res.suggestions.new_bills ?? []).map((b) => b.bucket_name ?? ''));
      setExpenseBucketSelections(
        (res.suggestions.new_expenses ?? []).map((e) => e.bucket_name ?? ''),
      );
      setBillReclassifiedAsExpense((res.suggestions.new_bills ?? []).map(() => false));
      setExpenseReclassifiedAsBill((res.suggestions.new_expenses ?? []).map(() => false));
    });
  }

  function handleApply() {
    if (!suggestions) return;
    startApplying(async () => {
      // Resolve which bucket each included line targets.
      const resolvedLines = suggestions.new_lines
        .map((l, i) => ({ l, i }))
        .filter(({ i }) => includeLines[i])
        .map(({ l, i }) => ({
          bucket_name: lineBucketSelections[i] ?? l.bucket_name,
          label: l.label,
          notes: l.notes,
          qty: l.qty,
          unit: l.unit,
          unit_price_cents: l.unit_price_cents,
          source_image_indexes: l.source_image_indexes ?? [],
        }));

      // Only create new buckets that are still referenced by an included line.
      const aiNewBucketNamesLower = new Set(
        suggestions.new_buckets.map((b) => b.name.toLowerCase()),
      );
      const referencedNewBuckets = new Set(
        resolvedLines
          .map((l) => l.bucket_name.toLowerCase())
          .filter((n) => aiNewBucketNamesLower.has(n)),
      );

      const plan = {
        projectId,
        description_addendum: includeAddendum ? suggestions.description_addendum : null,
        new_buckets: suggestions.new_buckets.filter(
          (b, i) => includeBuckets[i] && referencedNewBuckets.has(b.name.toLowerCase()),
        ),
        new_lines: resolvedLines,
        // Map-then-filter preserves original index so we can read from the
        // parallel billBucketSelections / expenseBucketSelections arrays.
        // A bill reclassified as expense moves to new_expenses below (amount
        // + GST merged). An expense reclassified as bill moves up here
        // (gst_cents defaults to 0 — operator can edit after).
        new_bills: [
          ...(suggestions.new_bills ?? [])
            .map((b, i) => ({ b, i }))
            .filter(({ i }) => includeBills[i] && !billReclassifiedAsExpense[i])
            .map(({ b, i }) => ({
              vendor: b.vendor,
              bill_date: b.bill_date,
              description: b.description,
              amount_cents: b.amount_cents,
              gst_cents: b.gst_cents,
              bucket_name: (billBucketSelections[i] ?? '') !== '' ? billBucketSelections[i] : null,
              source_image_index: b.source_image_index,
            })),
          ...(suggestions.new_expenses ?? [])
            .map((e, i) => ({ e, i }))
            .filter(({ i }) => includeExpenses[i] && expenseReclassifiedAsBill[i])
            .map(({ e, i }) => ({
              vendor: e.vendor,
              bill_date: e.expense_date,
              description: e.description,
              amount_cents: e.amount_cents,
              gst_cents: 0,
              bucket_name:
                (expenseBucketSelections[i] ?? '') !== '' ? expenseBucketSelections[i] : null,
              source_image_index: e.source_image_index,
            })),
        ],
        new_artifacts: (suggestions.new_artifacts ?? []).map((a) => ({
          kind: a.kind,
          label: a.label,
          summary: a.summary,
          source_image_index: a.source_image_index,
        })),
        new_expenses: [
          ...(suggestions.new_expenses ?? [])
            .map((e, i) => ({ e, i }))
            .filter(({ i }) => includeExpenses[i] && !expenseReclassifiedAsBill[i])
            .map(({ e, i }) => ({
              vendor: e.vendor,
              amount_cents: e.amount_cents,
              expense_date: e.expense_date,
              description: e.description,
              bucket_name:
                (expenseBucketSelections[i] ?? '') !== '' ? expenseBucketSelections[i] : null,
              source_image_index: e.source_image_index,
            })),
          ...(suggestions.new_bills ?? [])
            .map((b, i) => ({ b, i }))
            .filter(({ i }) => includeBills[i] && billReclassifiedAsExpense[i])
            .map(({ b, i }) => ({
              vendor: b.vendor,
              // Merge amount + GST — an expense is "paid", so total is what matters.
              amount_cents: b.amount_cents + (b.gst_cents ?? 0),
              expense_date: b.bill_date,
              description: b.description,
              bucket_name: (billBucketSelections[i] ?? '') !== '' ? billBucketSelections[i] : null,
              source_image_index: b.source_image_index,
            })),
        ],
        mergeSignals: includeSignals ? suggestions.signals : null,
        replyDraft: suggestions.reply_draft?.trim() || null,
      };
      const fd = new FormData();
      fd.set('plan', JSON.stringify(plan));
      // Send the same file list, in the same order, so server-side
      // source_image_indexes resolve correctly. Images are resized to
      // keep multi-file payloads under the server-action body cap.
      for (const s of staged) {
        const shrunk = await shrinkIfNeeded(s.file);
        fd.append('images', shrunk);
      }

      const res = await applyProjectAugmentAction(fd);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Applied ${res.appliedCount} change${res.appliedCount === 1 ? '' : 's'}`);
      reset();
      setOpen(false);
      router.refresh();
    });
  }

  function copyReply() {
    if (!suggestions?.reply_draft) return;
    navigator.clipboard
      .writeText(suggestions.reply_draft)
      .then(() => toast.success('Reply copied'));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        {/* Primary + bolder than the surrounding small action chips on
            purpose. This is the universal drop zone for anything related
            to this project — photos, bills, sub quotes, sketches — and
            it has to be impossible to miss. */}
        <Button className="gap-2 px-4 py-2 shadow-sm">
          <Sparkles className="size-4" />
          Add to project
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add to project</DialogTitle>
        </DialogHeader>

        {!suggestions ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Drop screenshots, photos, sketches, PDFs — anything for this project. Henry will sort
              it into the right buckets.
            </p>
            <DropArea onFiles={addFiles} />
            {staged.length > 0 ? (
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                {staged.map((s) => (
                  <div key={s.key} className="relative">
                    {s.previewUrl ? (
                      // biome-ignore lint/performance/noImgElement: local blob URL
                      <img
                        src={s.previewUrl}
                        alt=""
                        className="aspect-square w-full rounded-md border object-cover"
                      />
                    ) : (
                      <div className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-md border bg-muted/30 p-2 text-center">
                        <FileText className="size-5 text-muted-foreground" />
                        <p className="line-clamp-2 text-[10px] text-muted-foreground">
                          {s.file.name}
                        </p>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => removeStaged(s.key)}
                      className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white hover:bg-black/80"
                      aria-label="Remove"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="flex justify-end">
              <Button onClick={handleParse} disabled={isParsing || staged.length === 0}>
                {isParsing ? (
                  <>
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    Reading…
                  </>
                ) : (
                  'Read files'
                )}
              </Button>
            </div>
          </div>
        ) : (
          <div className="max-h-[70vh] space-y-4 overflow-y-auto">
            {suggestions.description_addendum ? (
              <SuggestionCard
                title="Add to project description"
                checked={includeAddendum}
                onToggle={() => setIncludeAddendum((v) => !v)}
              >
                <Textarea
                  rows={2}
                  value={suggestions.description_addendum}
                  onChange={(e) =>
                    setSuggestions({ ...suggestions, description_addendum: e.target.value })
                  }
                  className="text-sm"
                />
              </SuggestionCard>
            ) : null}

            {suggestions.new_buckets.length > 0 ? (
              <div className="rounded-md border">
                <p className="border-b bg-muted/30 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  New buckets ({suggestions.new_buckets.length})
                </p>
                <div className="divide-y">
                  {suggestions.new_buckets.map((b, i) => (
                    <SuggestionRow
                      // biome-ignore lint/suspicious/noArrayIndexKey: parallel state arrays bound by index
                      key={`b-${i}`}
                      checked={includeBuckets[i]}
                      onToggle={() =>
                        setIncludeBuckets((arr) => arr.map((v, j) => (j === i ? !v : v)))
                      }
                    >
                      <div className="flex flex-1 items-center gap-2">
                        <Input
                          value={b.section ?? ''}
                          placeholder="Section"
                          className="h-8 max-w-[140px] text-xs"
                          onChange={(e) => {
                            const next = [...suggestions.new_buckets];
                            next[i] = { ...next[i], section: e.target.value || null };
                            setSuggestions({ ...suggestions, new_buckets: next });
                          }}
                        />
                        <Input
                          value={b.name}
                          className="h-8 text-sm font-medium"
                          onChange={(e) => {
                            const next = [...suggestions.new_buckets];
                            next[i] = { ...next[i], name: e.target.value };
                            setSuggestions({ ...suggestions, new_buckets: next });
                          }}
                        />
                      </div>
                    </SuggestionRow>
                  ))}
                </div>
              </div>
            ) : null}

            {suggestions.new_lines.length > 0 ? (
              <div className="rounded-md border">
                <p className="border-b bg-muted/30 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  New cost lines ({suggestions.new_lines.length})
                </p>
                <div className="divide-y">
                  {suggestions.new_lines.map((l, i) => (
                    <SuggestionRow
                      // biome-ignore lint/suspicious/noArrayIndexKey: parallel state arrays bound by index
                      key={`l-${i}`}
                      checked={includeLines[i]}
                      onToggle={() =>
                        setIncludeLines((arr) => arr.map((v, j) => (j === i ? !v : v)))
                      }
                    >
                      <div className="flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            value={lineBucketSelections[i] ?? l.bucket_name}
                            onChange={(e) =>
                              setLineBucketSelections((arr) =>
                                arr.map((v, j) => (j === i ? e.target.value : v)),
                              )
                            }
                            className="h-7 rounded-md border bg-background px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
                          >
                            {existingBuckets.length > 0 && (
                              <optgroup label="Existing">
                                {existingBuckets.map((name) => (
                                  <option key={name} value={name}>
                                    {name}
                                  </option>
                                ))}
                              </optgroup>
                            )}
                            {suggestions.new_buckets.length > 0 && (
                              <optgroup label="New">
                                {suggestions.new_buckets.map((b) => (
                                  <option key={b.name} value={b.name}>
                                    + {b.name}
                                  </option>
                                ))}
                              </optgroup>
                            )}
                          </select>
                          <Input
                            value={l.label}
                            className="h-7 flex-1 text-sm font-medium"
                            onChange={(e) => {
                              const next = [...suggestions.new_lines];
                              next[i] = { ...next[i], label: e.target.value };
                              setSuggestions({ ...suggestions, new_lines: next });
                            }}
                          />
                        </div>
                        {l.notes ? (
                          <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                            {l.notes}
                          </p>
                        ) : null}
                        {l.source_image_indexes && l.source_image_indexes.length > 0 ? (
                          <p className="text-[10px] text-muted-foreground">
                            📎 Henry will attach {l.source_image_indexes.length} photo
                            {l.source_image_indexes.length === 1 ? '' : 's'}
                          </p>
                        ) : null}
                      </div>
                    </SuggestionRow>
                  ))}
                </div>
              </div>
            ) : null}

            {suggestions.new_artifacts && suggestions.new_artifacts.length > 0 ? (
              <div className="rounded-md border">
                <p className="border-b bg-muted/30 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Reference artifacts → Notes ({suggestions.new_artifacts.length})
                </p>
                <ul className="divide-y">
                  {suggestions.new_artifacts.map((a, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: parallel arrays bound by index
                    <li key={`a-${i}`} className="flex items-start gap-2 px-3 py-2">
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        {a.kind}
                      </span>
                      <div className="flex-1">
                        <p className="text-sm font-medium">{a.label}</p>
                        {a.summary ? (
                          <p className="text-xs text-muted-foreground">{a.summary}</p>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {suggestions.new_sub_quotes && suggestions.new_sub_quotes.length > 0 ? (
              <div className="rounded-md border">
                <p className="border-b bg-emerald-50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                  Sub quotes ({suggestions.new_sub_quotes.length}) — each opens its own review
                </p>
                <div className="divide-y">
                  {suggestions.new_sub_quotes.map((sq, i) => {
                    const saved = savedSubQuoteIndexes.has(i);
                    const sourceFile =
                      sq.source_image_index != null ? staged[sq.source_image_index]?.file : null;
                    return (
                      <div
                        // biome-ignore lint/suspicious/noArrayIndexKey: parallel state arrays bound by index
                        key={`sq-${i}`}
                        className="flex flex-wrap items-center gap-3 px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className="text-sm font-medium">{sq.vendor_name}</span>
                            <span className="text-sm font-semibold tabular-nums">
                              ${(sq.total_cents / 100).toFixed(2)}
                            </span>
                            {sq.quote_date ? (
                              <span className="text-xs text-muted-foreground">{sq.quote_date}</span>
                            ) : null}
                          </div>
                          {sq.scope_description ? (
                            <p className="truncate text-xs text-muted-foreground">
                              {sq.scope_description}
                            </p>
                          ) : null}
                          {sq.allocations.length > 0 ? (
                            <p className="mt-0.5 text-[11px] text-muted-foreground">
                              Suggested:{' '}
                              {sq.allocations
                                .map(
                                  (a) =>
                                    `${a.bucket_name} $${(a.allocated_cents / 100).toFixed(2)}`,
                                )
                                .join(' · ')}
                            </p>
                          ) : null}
                        </div>
                        {saved ? (
                          <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                            ✓ Saved
                          </span>
                        ) : (
                          <Button
                            size="xs"
                            onClick={() => setReviewingSubQuoteIndex(i)}
                            disabled={buckets.length === 0}
                            title={
                              buckets.length === 0
                                ? 'This project needs cost buckets first.'
                                : undefined
                            }
                          >
                            Review &amp; allocate
                          </Button>
                        )}
                        {sourceFile ? null : (
                          <span className="text-[10px] text-muted-foreground">(no attachment)</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {suggestions.new_bills && suggestions.new_bills.length > 0 ? (
              <div className="rounded-md border">
                <p className="border-b bg-amber-50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-amber-700">
                  Bills to log ({suggestions.new_bills.length}) — invoices received, not estimates
                </p>
                <div className="divide-y">
                  {suggestions.new_bills.map((b, i) => (
                    <SuggestionRow
                      // biome-ignore lint/suspicious/noArrayIndexKey: parallel state arrays bound by index
                      key={`bill-${i}`}
                      checked={includeBills[i]}
                      onToggle={() =>
                        setIncludeBills((arr) => arr.map((v, j) => (j === i ? !v : v)))
                      }
                    >
                      <div className="flex flex-1 items-start gap-2">
                        <div className="flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className="text-sm font-medium">
                              {b.vendor ?? 'Unknown vendor'}
                            </span>
                            <span className="text-sm font-semibold tabular-nums">
                              ${(b.amount_cents / 100).toFixed(2)}
                            </span>
                            {b.gst_cents > 0 && (
                              <span className="text-xs text-muted-foreground">
                                + ${(b.gst_cents / 100).toFixed(2)} GST
                              </span>
                            )}
                            {b.bill_date && (
                              <span className="text-xs text-muted-foreground">{b.bill_date}</span>
                            )}
                          </div>
                          {b.description && (
                            <p className="text-xs text-muted-foreground">{b.description}</p>
                          )}
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <select
                              value={billBucketSelections[i] ?? ''}
                              onChange={(e) =>
                                setBillBucketSelections((arr) =>
                                  arr.map((v, j) => (j === i ? e.target.value : v)),
                                )
                              }
                              className="h-7 rounded-md border bg-background px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
                            >
                              <option value="">— no bucket —</option>
                              {existingBuckets.length > 0 && (
                                <optgroup label="Existing">
                                  {existingBuckets.map((name) => (
                                    <option key={name} value={name}>
                                      {name}
                                    </option>
                                  ))}
                                </optgroup>
                              )}
                              {suggestions.new_buckets.length > 0 && (
                                <optgroup label="New">
                                  {suggestions.new_buckets.map((nb) => (
                                    <option key={nb.name} value={nb.name}>
                                      + {nb.name}
                                    </option>
                                  ))}
                                </optgroup>
                              )}
                            </select>
                            {b.source_image_index != null && (
                              <span className="text-[10px] text-muted-foreground">
                                📎 invoice attached
                              </span>
                            )}
                            {/* Bill → Expense reclassification. If the AI
                                called it a bill but it's actually a paid
                                receipt, the operator flips it here. */}
                            <label className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
                              <input
                                type="checkbox"
                                checked={billReclassifiedAsExpense[i] ?? false}
                                onChange={(ev) =>
                                  setBillReclassifiedAsExpense((arr) =>
                                    arr.map((v, j) => (j === i ? ev.target.checked : v)),
                                  )
                                }
                                className="size-3"
                              />
                              Already paid (treat as expense)
                            </label>
                          </div>
                        </div>
                      </div>
                    </SuggestionRow>
                  ))}
                </div>
              </div>
            ) : null}

            {suggestions.new_expenses && suggestions.new_expenses.length > 0 ? (
              <div className="rounded-md border">
                <p className="border-b bg-muted/30 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Expenses ({suggestions.new_expenses.length})
                </p>
                <div className="divide-y">
                  {suggestions.new_expenses.map((e, i) => (
                    <SuggestionRow
                      // biome-ignore lint/suspicious/noArrayIndexKey: parallel state arrays bound by index
                      key={`e-${i}`}
                      checked={includeExpenses[i]}
                      onToggle={() =>
                        setIncludeExpenses((arr) => arr.map((v, j) => (j === i ? !v : v)))
                      }
                    >
                      <div className="flex flex-1 items-start gap-2">
                        <div className="flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className="text-sm font-medium">
                              {e.vendor ?? 'Unknown vendor'}
                            </span>
                            <span className="text-sm font-semibold tabular-nums">
                              ${(e.amount_cents / 100).toFixed(2)}
                            </span>
                            {e.expense_date ? (
                              <span className="text-xs text-muted-foreground">
                                {e.expense_date}
                              </span>
                            ) : null}
                          </div>
                          {e.description ? (
                            <p className="text-xs text-muted-foreground">{e.description}</p>
                          ) : null}
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <select
                              value={expenseBucketSelections[i] ?? ''}
                              onChange={(ev) =>
                                setExpenseBucketSelections((arr) =>
                                  arr.map((v, j) => (j === i ? ev.target.value : v)),
                                )
                              }
                              className="h-7 rounded-md border bg-background px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
                            >
                              <option value="">— no bucket —</option>
                              {existingBuckets.length > 0 && (
                                <optgroup label="Existing">
                                  {existingBuckets.map((name) => (
                                    <option key={name} value={name}>
                                      {name}
                                    </option>
                                  ))}
                                </optgroup>
                              )}
                              {suggestions.new_buckets.length > 0 && (
                                <optgroup label="New">
                                  {suggestions.new_buckets.map((nb) => (
                                    <option key={nb.name} value={nb.name}>
                                      + {nb.name}
                                    </option>
                                  ))}
                                </optgroup>
                              )}
                            </select>
                            {e.source_image_index != null ? (
                              <span className="text-[10px] text-muted-foreground">
                                📎 receipt attached
                              </span>
                            ) : null}
                            <label className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
                              <input
                                type="checkbox"
                                checked={expenseReclassifiedAsBill[i] ?? false}
                                onChange={(ev) =>
                                  setExpenseReclassifiedAsBill((arr) =>
                                    arr.map((v, j) => (j === i ? ev.target.checked : v)),
                                  )
                                }
                                className="size-3"
                              />
                              Not yet paid (treat as bill)
                            </label>
                          </div>
                        </div>
                      </div>
                    </SuggestionRow>
                  ))}
                </div>
              </div>
            ) : null}

            {suggestions.signals.competitive ||
            suggestions.signals.urgency === 'high' ||
            suggestions.signals.upsells.length > 0 ||
            suggestions.signals.design_intent.length > 0 ? (
              <SuggestionCard
                title="Signals"
                checked={includeSignals}
                onToggle={() => setIncludeSignals((v) => !v)}
              >
                <div className="flex flex-wrap gap-1.5">
                  {suggestions.signals.competitive ? (
                    <Chip tone="amber">
                      Competitive
                      {suggestions.signals.competitor_count
                        ? ` (${suggestions.signals.competitor_count})`
                        : ''}
                    </Chip>
                  ) : null}
                  {suggestions.signals.urgency === 'high' ? (
                    <Chip tone="red">High urgency</Chip>
                  ) : null}
                  {suggestions.signals.upsells.map((u) => (
                    <Chip key={u.label} tone="blue">
                      Upsell: {u.label}
                    </Chip>
                  ))}
                  {suggestions.signals.design_intent.map((d) => (
                    <Chip key={d} tone="muted">
                      {d}
                    </Chip>
                  ))}
                </div>
              </SuggestionCard>
            ) : null}

            {suggestions.reply_draft ? (
              <div className="rounded-md border">
                <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Draft reply
                  </p>
                  <Button size="xs" variant="outline" onClick={copyReply}>
                    Copy
                  </Button>
                </div>
                <Textarea
                  rows={4}
                  value={suggestions.reply_draft}
                  onChange={(e) => setSuggestions({ ...suggestions, reply_draft: e.target.value })}
                  className="border-0 text-sm focus-visible:ring-0"
                />
              </div>
            ) : null}

            {suggestions.new_buckets.length === 0 &&
            suggestions.new_lines.length === 0 &&
            (suggestions.new_bills?.length ?? 0) === 0 &&
            (suggestions.new_expenses?.length ?? 0) === 0 &&
            !suggestions.description_addendum &&
            !suggestions.reply_draft ? (
              <p className="rounded-md border bg-muted/30 px-3 py-4 text-center text-sm text-muted-foreground">
                Henry didn't find anything new to add. Try a clearer screenshot or different photos.
              </p>
            ) : null}

            <div className="flex justify-between gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={() => setSuggestions(null)}>
                ← Back
              </Button>
              <Button onClick={handleApply} disabled={isApplying}>
                {isApplying ? (
                  <>
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    Applying…
                  </>
                ) : (
                  'Apply to project'
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>

      {/* Nested sub quote review dialog. Maps AI-suggested bucket names
          back to real bucket IDs before handing to SubQuoteForm. */}
      {reviewingSubQuoteIndex !== null && suggestions?.new_sub_quotes ? (
        <SubQuoteReviewDialog
          projectId={projectId}
          buckets={buckets}
          sq={suggestions.new_sub_quotes[reviewingSubQuoteIndex]}
          sourceFile={
            suggestions.new_sub_quotes[reviewingSubQuoteIndex].source_image_index != null
              ? (staged[
                  suggestions.new_sub_quotes[reviewingSubQuoteIndex].source_image_index as number
                ]?.file ?? null)
              : null
          }
          onClose={() => setReviewingSubQuoteIndex(null)}
          onSaved={() => {
            setSavedSubQuoteIndexes((prev) => {
              const next = new Set(prev);
              if (reviewingSubQuoteIndex !== null) next.add(reviewingSubQuoteIndex);
              return next;
            });
            setReviewingSubQuoteIndex(null);
          }}
        />
      ) : null}
    </Dialog>
  );
}

function SubQuoteReviewDialog({
  projectId,
  buckets,
  sq,
  sourceFile,
  onClose,
  onSaved,
}: {
  projectId: string;
  buckets: Bucket[];
  sq: NonNullable<AugmentResult['new_sub_quotes']>[number];
  sourceFile: File | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Resolve AI-suggested bucket names to real bucket IDs. Anything that
  // doesn't exist is dropped — operator allocates manually in the form.
  const bucketsByName = new Map(buckets.map((b) => [b.name, b]));
  const matched = sq.allocations
    .map((a) => {
      const hit = bucketsByName.get(a.bucket_name);
      return hit
        ? { bucket_id: hit.id, allocated_cents: a.allocated_cents, notes: a.reasoning }
        : null;
    })
    .filter(Boolean) as Array<{ bucket_id: string; allocated_cents: number; notes: string }>;

  const unmatched = sq.allocations.filter((a) => !bucketsByName.has(a.bucket_name));
  const unmatchedNote = unmatched.length
    ? `Henry suggested but no matching bucket:\n${unmatched
        .map((u) => `  • ${u.bucket_name} — $${(u.allocated_cents / 100).toFixed(2)}`)
        .join('\n')}`
    : '';

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" /> Review sub quote
          </DialogTitle>
        </DialogHeader>
        <SubQuoteForm
          projectId={projectId}
          buckets={buckets}
          initialValues={{
            vendor_name: sq.vendor_name,
            vendor_email: sq.vendor_email ?? '',
            vendor_phone: sq.vendor_phone ?? '',
            total_cents: sq.total_cents,
            scope_description: sq.scope_description ?? '',
            quote_date: sq.quote_date ?? '',
            valid_until: sq.valid_until ?? '',
            allocations: matched,
            attachment: sourceFile ?? undefined,
            notes: unmatchedNote,
          }}
          onDone={onSaved}
        />
      </DialogContent>
    </Dialog>
  );
}

function DropArea({ onFiles }: { onFiles: (files: FileList | File[]) => void }) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <label
      htmlFor="intake-files"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
      }}
      className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed p-6 text-center transition ${
        dragOver ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/30'
      }`}
    >
      <Upload className="size-5 text-muted-foreground" />
      <p className="text-sm font-medium">Drop or tap to add</p>
      <p className="text-xs text-muted-foreground">
        Screenshots, photos, sketches, PDFs (sub-trade quotes, drawings). Up to 12 files, 10MB each.
      </p>
      <input
        id="intake-files"
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </label>
  );
}

function SuggestionCard({
  title,
  checked,
  onToggle,
  children,
}: {
  title: string;
  checked: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-md border ${checked ? '' : 'opacity-50'}`}>
      <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-1.5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </p>
        <input type="checkbox" checked={checked} onChange={onToggle} className="size-4" />
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function SuggestionRow({
  checked,
  onToggle,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex items-start gap-3 px-3 py-2 ${checked ? '' : 'opacity-40'}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-1.5 size-4 shrink-0"
      />
      {children}
    </div>
  );
}

function Chip({
  tone,
  children,
}: {
  tone: 'amber' | 'red' | 'blue' | 'muted';
  children: React.ReactNode;
}) {
  const cls =
    tone === 'amber'
      ? 'bg-amber-100 text-amber-800'
      : tone === 'red'
        ? 'bg-red-100 text-red-800'
        : tone === 'blue'
          ? 'bg-blue-100 text-blue-800'
          : 'bg-muted text-muted-foreground';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {children}
    </span>
  );
}
