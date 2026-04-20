'use client';

/**
 * Voice memo upload and transcription component.
 *
 * Supports both MediaRecorder (in-browser recording) and file upload.
 * After upload, user triggers transcription which extracts work items
 * mapped to cost buckets.
 */

import { Loader2, Mic, MicOff, Trash2, Upload, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  addMemoItemToCostLinesAction,
  deleteMemoAction,
  dismissMemoItemAction,
  transcribeMemoAction,
  uploadMemoAction,
} from '@/server/actions/project-memos';

type BucketOption = {
  id: string;
  name: string;
  section: string;
};

type WorkItem = {
  area: string;
  description: string;
  suggested_bucket: string;
  section: string;
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
};

type MemoUploadProps = {
  projectId: string;
  memos: MemoRow[];
  buckets: BucketOption[];
};

export function MemoUpload({ projectId, memos, buckets }: MemoUploadProps) {
  const router = useRouter();
  const [isRecording, setIsRecording] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [transcribing, setTranscribing] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Poll for status changes while any memo is still being processed server-side.
  // This decouples the UI from the original fetch's lifetime — if the server
  // action finishes after the client has moved on, we still pick up the result.
  const hasInFlight = memos.some(
    (m) => m.status === 'pending' || m.status === 'transcribing' || m.status === 'extracting',
  );
  useEffect(() => {
    if (!hasInFlight) return;
    const interval = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(interval);
  }, [hasInFlight, router]);

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        for (const t of stream.getTracks()) t.stop();
        uploadBlob(blob, 'recording.webm');
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

  function uploadBlob(blob: Blob, filename: string) {
    startTransition(async () => {
      const formData = new FormData();
      formData.append('project_id', projectId);
      formData.append('audio', blob, filename);

      const result = await uploadMemoAction(formData);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }

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

        {isPending && !transcribing ? (
          <span className="text-sm text-muted-foreground flex items-center gap-1">
            <Loader2 className="size-3 animate-spin" /> Uploading...
          </span>
        ) : null}
      </div>

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
                  <span className="text-xs font-medium uppercase tracking-wider">
                    {memo.status}
                  </span>
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
              memo.status === 'extracting' ? (
                <p className="text-sm text-muted-foreground flex items-center gap-1">
                  <Loader2 className="size-3 animate-spin" /> Transcribing...
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
                  <div>
                    <h4 className="text-xs font-medium text-muted-foreground mb-1">Transcript</h4>
                    <p className="text-sm whitespace-pre-wrap">{memo.transcript}</p>
                  </div>

                  {memo.ai_extraction &&
                  Array.isArray((memo.ai_extraction as Record<string, unknown>).work_items) &&
                  ((memo.ai_extraction as Record<string, unknown>).work_items as unknown[]).length >
                    0 ? (
                    <div>
                      <h4 className="text-xs font-medium text-muted-foreground mb-2">
                        Extracted Work Items — review, edit, and add to estimate
                      </h4>
                      <div className="space-y-2">
                        {(
                          (memo.ai_extraction as Record<string, unknown>).work_items as WorkItem[]
                        ).map((item, index) => (
                          <WorkItemRow
                            key={`${memo.id}-${item.section}-${item.suggested_bucket}-${item.area}-${item.description}`}
                            memoId={memo.id}
                            itemIndex={index}
                            item={item}
                            buckets={buckets}
                            onDone={() => router.refresh()}
                          />
                        ))}
                      </div>
                    </div>
                  ) : null}
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

type WorkItemRowProps = {
  memoId: string;
  itemIndex: number;
  item: WorkItem;
  buckets: BucketOption[];
  onDone: () => void;
};

function WorkItemRow({ memoId, itemIndex, item, buckets, onDone }: WorkItemRowProps) {
  const defaultLabel = item.area ? `${item.area}: ${item.description}` : item.description;

  // Try to find a bucket matching suggested_bucket name (case-insensitive)
  // inside the same section, then fall back to any section match, then none.
  const suggestedLower = item.suggested_bucket.toLowerCase();
  const sectionLower = item.section.toLowerCase();
  const matchedBucket =
    buckets.find(
      (b) => b.name.toLowerCase() === suggestedLower && b.section.toLowerCase() === sectionLower,
    ) ??
    buckets.find((b) => b.name.toLowerCase() === suggestedLower) ??
    null;

  const [label, setLabel] = useState(defaultLabel);
  const [bucketId, setBucketId] = useState<string>(matchedBucket?.id ?? '');
  const [category, setCategory] = useState<CostCategory>('sub');
  const [qty, setQty] = useState('1');
  const [unit, setUnit] = useState('ls');
  const [unitCostDollars, setUnitCostDollars] = useState('');
  const [isPending, startTransition] = useTransition();

  function handleAdd() {
    const qtyNum = Number(qty);
    const unitCostCents = Math.round(Number(unitCostDollars || '0') * 100);
    if (!label.trim()) return toast.error('Label is required.');
    if (!bucketId) return toast.error('Pick a bucket.');
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) return toast.error('Quantity must be positive.');

    startTransition(async () => {
      const result = await addMemoItemToCostLinesAction({
        memoId,
        itemIndex,
        bucket_id: bucketId,
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

  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-2">
      <div className="text-xs text-muted-foreground">
        AI suggestion: <span className="font-medium">{item.section}</span> /{' '}
        <span className="font-medium">{item.suggested_bucket}</span>
      </div>
      <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Line item" />
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <Select value={bucketId} onValueChange={setBucketId}>
          <SelectTrigger className="col-span-2">
            <SelectValue placeholder="Bucket" />
          </SelectTrigger>
          <SelectContent>
            {buckets.length === 0 ? (
              <SelectItem value="__none" disabled>
                No buckets — create some first
              </SelectItem>
            ) : (
              buckets.map((b) => (
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
