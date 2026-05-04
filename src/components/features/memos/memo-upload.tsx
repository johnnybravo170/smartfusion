'use client';

/**
 * Voice memo upload and transcription component.
 *
 * Supports both MediaRecorder (in-browser recording) and file upload.
 * After upload, user triggers transcription which extracts work items
 * mapped to budget categories.
 */

import { ImagePlus, Loader2, Mic, MicOff, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { resizeImage } from '@/lib/storage/resize-image';
import {
  addMemoItemToCostLinesAction,
  deleteMemoAction,
  dismissMemoItemAction,
  reExtractMemoAction,
  setActiveMemoVersionAction,
  transcribeMemoAction,
  uploadMemoAction,
} from '@/server/actions/project-memos';

type MemoPhoto = {
  id: string;
  url: string | null;
  caption: string | null;
};

type CategoryOption = {
  id: string;
  name: string;
  section: string;
};

type WorkItem = {
  area: string;
  description: string;
  suggested_category: string;
  section: string;
  referenced_photo_indexes?: number[];
};

type CostCategory = 'material' | 'labour' | 'sub' | 'equipment' | 'overhead';
const CATEGORIES: { value: CostCategory; label: string }[] = [
  { value: 'material', label: 'Material' },
  { value: 'labour', label: 'Labour' },
  { value: 'sub', label: 'Sub' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'overhead', label: 'Overhead' },
];

type MemoRow = {
  id: string;
  status: string;
  transcript: string | null;
  ai_extraction: Record<string, unknown> | null;
  created_at: string;
  photos: MemoPhoto[];
};

export type MemoUploadProps = {
  projectId: string;
  memos: MemoRow[];
  categories: CategoryOption[];
};

type StagedPhoto = { key: string; file: File; previewUrl: string };

export function MemoUpload({ projectId, memos, categories }: MemoUploadProps) {
  const router = useRouter();
  const [isRecording, setIsRecording] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [transcribing, setTranscribing] = useState<string | null>(null);
  const [stagedPhotos, setStagedPhotos] = useState<StagedPhoto[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  // Poll for status changes while any memo is still being processed server-side.
  // This decouples the UI from the original fetch's lifetime — if the server
  // action finishes after the client has moved on, we still pick up the result.
  const hasInFlight = memos.some(
    (m) =>
      m.status === 'pending' ||
      m.status === 'transcribing' ||
      m.status === 'extracting' ||
      m.status === 'rethinking',
  );
  useEffect(() => {
    if (!hasInFlight) return;
    const interval = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(interval);
  }, [hasInFlight, router]);

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Pick a mime the browser will actually accept. iOS Safari rejects
      // audio/webm and produces audio/mp4 (AAC); Chrome/Android prefer
      // audio/webm. Probe in preference order, fall back to the browser
      // default when none of our candidates are supported.
      const ext = pickRecordingExt();
      const mime = extToMime(ext);
      const mediaRecorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        // The browser may strip mime parameters or pick a different
        // codec — trust `mediaRecorder.mimeType` over our request.
        const actualMime = mediaRecorder.mimeType || mime || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: actualMime });
        for (const t of stream.getTracks()) t.stop();
        uploadBlob(blob, `recording.${ext}`);
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch {
      toast.error('Could not access microphone. Please check permissions.');
    }
  }

  function stopRecording() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    uploadBlob(file, file.name);
    // Reset file input
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleAddPhotos(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) {
      if (photoInputRef.current) photoInputRef.current.value = '';
      return;
    }
    setStagedPhotos((prev) => [
      ...prev,
      ...files.map((file) => ({
        key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        previewUrl: URL.createObjectURL(file),
      })),
    ]);
    if (photoInputRef.current) photoInputRef.current.value = '';
  }

  function removeStagedPhoto(key: string) {
    setStagedPhotos((prev) => {
      const target = prev.find((p) => p.key === key);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.key !== key);
    });
  }

  function uploadBlob(blob: Blob, filename: string) {
    // Snapshot staged photos before starting the async transition so new
    // photos added mid-upload aren't dropped.
    const photosToSend = stagedPhotos;
    startTransition(async () => {
      const formData = new FormData();
      formData.append('project_id', projectId);
      formData.append('audio', blob, filename);

      // Resize and bundle each staged photo into the same upload.
      for (const staged of photosToSend) {
        try {
          const resized = await resizeImage(staged.file);
          const outName = /\.(jpe?g|png|webp|gif)$/i.test(staged.file.name)
            ? staged.file.name
            : `${staged.file.name}.jpg`;
          const finalFile =
            resized instanceof File
              ? resized
              : new File([resized], outName, { type: 'image/jpeg' });
          formData.append('photo', finalFile);
        } catch {
          // Resize failures fall back to the original.
          formData.append('photo', staged.file);
        }
      }

      const result = await uploadMemoAction(formData);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      // Clear staged photos; server now owns them.
      for (const p of photosToSend) URL.revokeObjectURL(p.previewUrl);
      setStagedPhotos([]);

      toast.success('Audio uploaded. Transcribing...');

      // Fire transcription without awaiting so the record/upload button
      // frees up immediately. The polling effect will pick up the result.
      transcribeMemoAction(result.id)
        .then((r) => {
          if (r.ok) {
            toast.success('Transcription complete!');
          } else {
            toast.error(r.error);
          }
          router.refresh();
        })
        .catch((err) => {
          toast.error(`Transcription failed: ${err instanceof Error ? err.message : String(err)}`);
          router.refresh();
        });
    });
  }

  function handleTranscribe(memoId: string) {
    setTranscribing(memoId);
    startTransition(async () => {
      const result = await transcribeMemoAction(memoId);
      setTranscribing(null);
      if (result.ok) {
        toast.success('Transcription complete!');
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleDelete(memoId: string) {
    if (!confirm('Delete this voice memo? This cannot be undone.')) return;
    startTransition(async () => {
      const result = await deleteMemoAction(memoId);
      if (result.ok) {
        toast.success('Memo deleted.');
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="space-y-6">
      {/* Upload controls */}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant={isRecording ? 'destructive' : 'default'}
          onClick={isRecording ? stopRecording : startRecording}
          disabled={isPending}
        >
          {isRecording ? (
            <>
              <MicOff className="mr-2 size-4" /> Stop recording
            </>
          ) : (
            <>
              <Mic className="mr-2 size-4" /> Record memo
            </>
          )}
        </Button>

        <span className="text-sm text-muted-foreground">or</span>

        <Button
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          disabled={isPending}
        >
          <Upload className="mr-2 size-4" /> Upload audio
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={handleFileUpload}
        />

        <Button
          variant="outline"
          onClick={() => photoInputRef.current?.click()}
          disabled={isPending}
        >
          <ImagePlus className="mr-2 size-4" /> Add photos
        </Button>
        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleAddPhotos}
        />

        {isPending && !transcribing ? (
          <span className="text-sm text-muted-foreground flex items-center gap-1">
            <Loader2 className="size-3 animate-spin" /> Uploading...
          </span>
        ) : null}
      </div>

      {/* Staged photos (not yet uploaded) */}
      {stagedPhotos.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {stagedPhotos.map((p) => (
            <div
              key={p.key}
              className="relative size-20 overflow-hidden rounded-md border bg-muted"
            >
              {/* biome-ignore lint/performance/noImgElement: blob-URL preview */}
              <img src={p.previewUrl} alt="" className="size-full object-cover" />
              <button
                type="button"
                onClick={() => removeStagedPhoto(p.key)}
                className="absolute right-0.5 top-0.5 rounded-full bg-background/80 p-0.5 hover:bg-background"
                aria-label="Remove photo"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
          <span className="self-center text-xs text-muted-foreground">
            {stagedPhotos.length} attached — will upload with the next recording
          </span>
        </div>
      ) : null}

      {/* Memo list */}
      {memos.length > 0 ? (
        <div className="space-y-4">
          {memos.map((memo) => (
            <div key={memo.id} className="rounded-lg border p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground">
                  {new Date(memo.created_at).toLocaleDateString('en-CA', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </span>
                <div className="flex items-center gap-3">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    onClick={() => handleDelete(memo.id)}
                    disabled={isPending}
                    aria-label="Delete memo"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>

              {memo.status === 'pending' ||
              memo.status === 'transcribing' ||
              memo.status === 'extracting' ||
              memo.status === 'rethinking' ? (
                <p className="text-sm text-muted-foreground flex items-center gap-1">
                  <Loader2 className="size-3 animate-spin" /> {statusMessage(memo.status)}
                </p>
              ) : null}

              {memo.status === 'failed' ? (
                <div>
                  <p className="text-sm text-red-600 mb-2">Transcription failed.</p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleTranscribe(memo.id)}
                    disabled={isPending}
                  >
                    Retry
                  </Button>
                </div>
              ) : null}

              {memo.status === 'ready' && memo.transcript ? (
                <div className="space-y-3">
                  {memo.photos.length > 0 ? (
                    <div>
                      <h4 className="text-xs font-medium text-muted-foreground mb-1">
                        Photos ({memo.photos.length})
                      </h4>
                      <div className="flex flex-wrap gap-2">
                        {memo.photos.map((p, i) => (
                          <PhotoThumbnail key={p.id} photo={p} index={i} />
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <div>
                    <h4 className="text-xs font-medium text-muted-foreground mb-1">Transcript</h4>
                    <p className="text-sm whitespace-pre-wrap">{memo.transcript}</p>
                  </div>

                  <ExtractedWorkItems
                    memo={memo}
                    categories={categories}
                    onRefresh={() => router.refresh()}
                  />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No memos yet. Record or upload audio from a site walk-through.
        </p>
      )}
    </div>
  );
}

/**
 * Return the file extension to use for a freshly recorded blob, based
 * on what the current browser's MediaRecorder actually supports. iOS
 * Safari produces m4a; everywhere else we prefer webm.
 */
function pickRecordingExt(): 'webm' | 'm4a' {
  if (typeof MediaRecorder === 'undefined') return 'webm';
  if (MediaRecorder.isTypeSupported('audio/webm')) return 'webm';
  if (MediaRecorder.isTypeSupported('audio/mp4')) return 'm4a';
  return 'webm';
}

function extToMime(ext: 'webm' | 'm4a'): string {
  return ext === 'webm' ? 'audio/webm' : 'audio/mp4';
}

function statusMessage(status: string): string {
  if (status === 'pending') return 'Saving your walkthrough…';
  if (status === 'transcribing') return 'Listening to your walkthrough…';
  if (status === 'extracting') return "Henry's making sense of it…";
  if (status === 'rethinking') return "Henry's having another think — this can take a minute…";
  return 'Working…';
}

type ExtractionView = {
  v1: { work_items: WorkItem[] } | null;
  v2: { work_items: WorkItem[] } | null;
  active: 'v1' | 'v2';
};

function readExtractionEnvelope(raw: Record<string, unknown> | null): ExtractionView | null {
  if (!raw) return null;
  // Versioned envelope (post-migration 0174).
  if ('v1' in raw || 'v2' in raw || 'active' in raw) {
    const v1 = (raw.v1 as { work_items?: WorkItem[] } | null) ?? null;
    const v2 = (raw.v2 as { work_items?: WorkItem[] } | null) ?? null;
    const active: 'v1' | 'v2' = raw.active === 'v2' ? 'v2' : 'v1';
    return {
      v1: v1 && Array.isArray(v1.work_items) ? { work_items: v1.work_items } : null,
      v2: v2 && Array.isArray(v2.work_items) ? { work_items: v2.work_items } : null,
      active,
    };
  }
  // Legacy flat shape — treat as v1.
  if (Array.isArray((raw as { work_items?: unknown }).work_items)) {
    return {
      v1: { work_items: (raw as { work_items: WorkItem[] }).work_items },
      v2: null,
      active: 'v1',
    };
  }
  return null;
}

function ExtractedWorkItems({
  memo,
  categories,
  onRefresh,
}: {
  memo: MemoRow;
  categories: CategoryOption[];
  onRefresh: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const view = readExtractionEnvelope(memo.ai_extraction);
  if (!view) return null;

  const activeSlot = view[view.active];
  const items = activeSlot?.work_items ?? [];
  const hasV2 = !!view.v2;

  function rethink() {
    startTransition(async () => {
      const result = await reExtractMemoAction(memo.id);
      if (!result.ok) toast.error(result.error);
      onRefresh();
    });
  }

  function switchTo(version: 'v1' | 'v2') {
    if (version === view?.active) return;
    startTransition(async () => {
      const result = await setActiveMemoVersionAction(memo.id, version);
      if (!result.ok) toast.error(result.error);
      onRefresh();
    });
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h4 className="text-xs font-medium text-muted-foreground">
          Extracted Work Items — review, edit, and add to estimate
        </h4>
        <div className="flex items-center gap-2">
          {hasV2 ? (
            <div
              className="inline-flex rounded-md border bg-muted p-0.5 text-xs"
              role="tablist"
              aria-label="Extraction version"
            >
              <button
                type="button"
                role="tab"
                aria-selected={view.active === 'v1'}
                onClick={() => switchTo('v1')}
                disabled={isPending}
                className={`px-2 py-0.5 rounded ${
                  view.active === 'v1' ? 'bg-background shadow-sm' : 'text-muted-foreground'
                }`}
              >
                First take
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view.active === 'v2'}
                onClick={() => switchTo('v2')}
                disabled={isPending}
                className={`px-2 py-0.5 rounded ${
                  view.active === 'v2' ? 'bg-background shadow-sm' : 'text-muted-foreground'
                }`}
              >
                Second think
              </button>
            </div>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={rethink}
            disabled={isPending}
            title="Have Henry think harder about the transcript. Takes a bit longer."
          >
            <Sparkles className="mr-1.5 size-3" />
            {hasV2 ? 'Think again' : 'Have another think'}
          </Button>
        </div>
      </div>
      {items.length > 0 ? (
        <div className="space-y-2">
          {items.map((item, index) => (
            <WorkItemRow
              key={`${memo.id}-${view.active}-${item.section}-${item.suggested_category}-${item.area}-${item.description}`}
              memoId={memo.id}
              itemIndex={index}
              item={item}
              categories={categories}
              memoPhotos={memo.photos}
              onDone={onRefresh}
            />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground italic">
          No work items in this version. Try "Have another think" if the first pass missed things.
        </p>
      )}
    </div>
  );
}

function PhotoThumbnail({
  photo,
  index,
  size = 'lg',
}: {
  photo: MemoPhoto;
  index: number;
  size?: 'sm' | 'lg';
}) {
  const sizeClass = size === 'sm' ? 'size-8' : 'size-20';
  const badgeClass = size === 'sm' ? 'text-[8px] px-0.5' : 'text-[10px] px-1';
  if (!photo.url) {
    return (
      <div
        className={`flex items-center justify-center rounded-md border bg-muted text-xs text-muted-foreground ${sizeClass}`}
      >
        #{index}
      </div>
    );
  }
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className={`relative overflow-hidden rounded-md border bg-muted transition hover:ring-2 hover:ring-primary ${sizeClass}`}
          aria-label={`Open photo ${index}`}
        >
          {/* biome-ignore lint/performance/noImgElement: signed URL bypasses next/image */}
          <img src={photo.url} alt="" className="size-full object-cover" loading="lazy" />
          <span
            className={`absolute right-0.5 bottom-0.5 rounded bg-background/80 font-medium ${badgeClass}`}
          >
            {index}
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Photo {index}</DialogTitle>
        </DialogHeader>
        {/* biome-ignore lint/performance/noImgElement: signed URL bypasses next/image */}
        <img
          src={photo.url}
          alt={photo.caption ?? ''}
          className="max-h-[70vh] w-full rounded-md object-contain"
        />
      </DialogContent>
    </Dialog>
  );
}

type WorkItemRowProps = {
  memoId: string;
  itemIndex: number;
  item: WorkItem;
  categories: CategoryOption[];
  memoPhotos: MemoPhoto[];
  onDone: () => void;
};

function WorkItemRow({
  memoId,
  itemIndex,
  item,
  categories,
  memoPhotos,
  onDone,
}: WorkItemRowProps) {
  const defaultLabel = item.area ? `${item.area}: ${item.description}` : item.description;

  // Try to find a category matching suggested_category name (case-insensitive)
  // inside the same section, then fall back to any section match, then none.
  const suggestedLower = item.suggested_category.toLowerCase();
  const sectionLower = item.section.toLowerCase();
  const matchedCategory =
    categories.find(
      (b) => b.name.toLowerCase() === suggestedLower && b.section.toLowerCase() === sectionLower,
    ) ??
    categories.find((b) => b.name.toLowerCase() === suggestedLower) ??
    null;

  const [label, setLabel] = useState(defaultLabel);
  const [categoryId, setCategoryId] = useState<string>(matchedCategory?.id ?? '');
  const [category, setCategory] = useState<CostCategory>('sub');
  const [qty, setQty] = useState('1');
  const [unit, setUnit] = useState('ls');
  const [unitCostDollars, setUnitCostDollars] = useState('');
  const [isPending, startTransition] = useTransition();

  function handleAdd() {
    const qtyNum = Number(qty);
    const unitCostCents = Math.round(Number(unitCostDollars || '0') * 100);
    if (!label.trim()) return toast.error('Label is required.');
    if (!categoryId) return toast.error('Pick a category.');
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) return toast.error('Quantity must be positive.');

    startTransition(async () => {
      const result = await addMemoItemToCostLinesAction({
        memoId,
        itemIndex,
        budget_category_id: categoryId,
        category,
        label: label.trim(),
        qty: qtyNum,
        unit: unit.trim() || 'ls',
        unit_cost_cents: unitCostCents,
      });
      if (result.ok) {
        toast.success('Added to estimate.');
        onDone();
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleDismiss() {
    startTransition(async () => {
      const result = await dismissMemoItemAction(memoId, itemIndex);
      if (result.ok) {
        onDone();
      } else {
        toast.error(result.error);
      }
    });
  }

  const referenced = (item.referenced_photo_indexes ?? [])
    .map((idx) => ({ idx, photo: memoPhotos[idx] }))
    .filter((r) => !!r.photo);

  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          AI suggestion: <span className="font-medium">{item.section}</span> /{' '}
          <span className="font-medium">{item.suggested_category}</span>
        </span>
        {referenced.length > 0 ? (
          <div className="flex items-center gap-1">
            {referenced.map(({ idx, photo }) => (
              <PhotoThumbnail key={photo.id} photo={photo} index={idx} size="sm" />
            ))}
          </div>
        ) : null}
      </div>
      <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Line item" />
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <Select value={categoryId} onValueChange={setCategoryId}>
          <SelectTrigger className="col-span-2">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            {categories.length === 0 ? (
              <SelectItem value="__none" disabled>
                No categories — create some first
              </SelectItem>
            ) : (
              categories.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.section}: {b.name}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
        <Select value={category} onValueChange={(v) => setCategory(v as CostCategory)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CATEGORIES.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="number"
          min="0"
          step="0.01"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          placeholder="Qty"
        />
        <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="Unit" />
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min="0"
          step="0.01"
          value={unitCostDollars}
          onChange={(e) => setUnitCostDollars(e.target.value)}
          placeholder="Unit cost ($)"
          className="max-w-[180px]"
        />
        <Button size="sm" onClick={handleAdd} disabled={isPending}>
          {isPending ? <Loader2 className="size-3 animate-spin" /> : 'Add to estimate'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={handleDismiss}
          disabled={isPending}
          aria-label="Dismiss"
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}
