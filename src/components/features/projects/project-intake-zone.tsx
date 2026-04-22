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
import { useRouter } from 'next/navigation';
import { useCallback, useState, useTransition } from 'react';
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

export function ProjectIntakeZone({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [suggestions, setSuggestions] = useState<AugmentResult | null>(null);
  // Per-suggestion include flags so operator can trim.
  const [includeBuckets, setIncludeBuckets] = useState<boolean[]>([]);
  const [includeLines, setIncludeLines] = useState<boolean[]>([]);
  const [includeExpenses, setIncludeExpenses] = useState<boolean[]>([]);
  const [includeAddendum, setIncludeAddendum] = useState(true);
  const [includeSignals, setIncludeSignals] = useState(true);
  const [isParsing, startParsing] = useTransition();
  const [isApplying, startApplying] = useTransition();

  const reset = useCallback(() => {
    for (const s of staged) {
      if (s.previewUrl) URL.revokeObjectURL(s.previewUrl);
    }
    setStaged([]);
    setSuggestions(null);
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
      setIncludeBuckets(res.suggestions.new_buckets.map(() => true));
      setIncludeLines(res.suggestions.new_lines.map(() => true));
      setIncludeExpenses((res.suggestions.new_expenses ?? []).map(() => true));
      setIncludeAddendum(!!res.suggestions.description_addendum);
      setIncludeSignals(true);
    });
  }

  function handleApply() {
    if (!suggestions) return;
    startApplying(async () => {
      const plan = {
        projectId,
        description_addendum: includeAddendum ? suggestions.description_addendum : null,
        new_buckets: suggestions.new_buckets.filter((_, i) => includeBuckets[i]),
        new_lines: suggestions.new_lines
          .filter((_, i) => includeLines[i])
          .map((l) => ({
            bucket_name: l.bucket_name,
            label: l.label,
            notes: l.notes,
            qty: l.qty,
            unit: l.unit,
            unit_price_cents: l.unit_price_cents,
            source_image_indexes: l.source_image_indexes ?? [],
          })),
        new_expenses: (suggestions.new_expenses ?? [])
          .filter((_, i) => includeExpenses[i])
          .map((e) => ({
            vendor: e.vendor,
            amount_cents: e.amount_cents,
            expense_date: e.expense_date,
            description: e.description,
            bucket_name: e.bucket_name,
            source_image_index: e.source_image_index,
          })),
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
        <Button size="sm" variant="outline" className="gap-1.5">
          <Sparkles className="size-3.5" />
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
                    Parsing…
                  </>
                ) : (
                  'Parse'
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
                      <div className="flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                            {l.bucket_name}
                          </span>
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
                          <div className="mt-0.5 flex items-center gap-2">
                            {e.bucket_name ? (
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                                {e.bucket_name}
                              </span>
                            ) : null}
                            {e.source_image_index != null ? (
                              <span className="text-[10px] text-muted-foreground">
                                📎 receipt attached
                              </span>
                            ) : null}
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
