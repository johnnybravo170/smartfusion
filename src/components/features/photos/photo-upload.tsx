'use client';

/**
 * Drag-drop + click + mobile-camera photo uploader.
 *
 * Workflow per file:
 *   1. User picks / drops one or more images (or snaps via phone camera).
 *   2. Each staged entry lives in local state with its own tag + caption.
 *   3. On "Upload", we resize each File in the browser, then POST it to
 *      `uploadPhotoAction` as FormData. Sequential (not parallel) so the
 *      progress counter stays meaningful and we don't hammer the server.
 *   4. Successes drop out of the staged list; failures surface a toast and
 *      stay put so the user can retry.
 *
 * Why resize on the client: mobile cameras routinely produce 5–15MB
 * originals. Shipping those to storage is wasteful and slow, and Supabase
 * caps uploads at 50MiB by default.
 *
 * The component is intentionally standalone — it takes a `jobId` prop and
 * calls an `onUploadComplete` callback. Track D does not wire it into the
 * job-detail page; that integration happens in Phase 1C.
 */

import { ImagePlus, Loader2, Upload, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { resizeImage } from '@/lib/storage/resize-image';
import { cn } from '@/lib/utils';
import { type PhotoTag, photoTagLabels, photoTags } from '@/lib/validators/photo';
import { uploadPhotoAction } from '@/server/actions/photos';
import { PhotoTagSelect } from './photo-tag-select';

type StagedPhoto = {
  key: string;
  file: File;
  previewUrl: string;
  tag: PhotoTag;
  caption: string;
};

function makeKey() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function PhotoUpload({
  jobId,
  projectId,
  onUploadComplete,
}: {
  jobId?: string;
  projectId?: string;
  onUploadComplete?: () => void;
}) {
  if (!jobId && !projectId) {
    throw new Error('PhotoUpload needs either jobId or projectId.');
  }
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [staged, setStaged] = useState<StagedPhoto[]>([]);
  const [pending, startTransition] = useTransition();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const addFiles = useCallback((fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) {
      toast.error('Only image files are supported.');
      return;
    }
    setStaged((prev) => [
      ...prev,
      ...files.map((file) => ({
        key: makeKey(),
        file,
        previewUrl: URL.createObjectURL(file),
        tag: 'other' as PhotoTag,
        caption: '',
      })),
    ]);
  }, []);

  function handleFileInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    if (event.target.files && event.target.files.length > 0) {
      addFiles(event.target.files);
    }
    // Allow picking the same filename twice in a row.
    event.target.value = '';
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDraggingOver(false);
    if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
      addFiles(event.dataTransfer.files);
    }
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDraggingOver(true);
  }

  function handleDragLeave(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDraggingOver(false);
  }

  function removeStaged(key: string) {
    setStaged((prev) => {
      const target = prev.find((p) => p.key === key);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.key !== key);
    });
  }

  function updateStaged(key: string, patch: Partial<StagedPhoto>) {
    setStaged((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  }

  function handleUpload() {
    if (staged.length === 0) return;

    startTransition(async () => {
      const total = staged.length;
      setProgress({ done: 0, total });
      const remaining: StagedPhoto[] = [];
      let successes = 0;

      for (let i = 0; i < staged.length; i++) {
        const entry = staged[i];
        try {
          const resized = await resizeImage(entry.file);
          // Ensure we send a File (for `file.name`) even if resize returned a Blob.
          const outName = /\.(jpe?g|png|webp|gif)$/i.test(entry.file.name)
            ? entry.file.name
            : `${entry.file.name}.jpg`;
          const finalFile =
            resized instanceof File
              ? resized
              : new File([resized], outName, { type: 'image/jpeg' });

          const fd = new FormData();
          fd.append('file', finalFile);
          if (jobId) fd.append('job_id', jobId);
          if (projectId) fd.append('project_id', projectId);
          fd.append('tag', entry.tag);
          fd.append('caption', entry.caption);

          const result = await uploadPhotoAction(fd);
          if (!result.ok) {
            toast.error(`${entry.file.name}: ${result.error}`);
            remaining.push(entry);
          } else {
            URL.revokeObjectURL(entry.previewUrl);
            successes += 1;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          toast.error(`${entry.file.name}: ${msg}`);
          remaining.push(entry);
        }
        setProgress({ done: i + 1, total });
      }

      setStaged(remaining);
      setProgress(null);

      if (successes > 0) {
        toast.success(successes === 1 ? 'Photo uploaded.' : `${successes} photos uploaded.`);
        router.refresh();
        onUploadComplete?.();
      }
    });
  }

  const disabled = pending;

  return (
    <div className="flex flex-col gap-3">
      {/* Direct buttons — always work on iOS */}
      <div className="flex gap-2">
        <label className="flex-1 cursor-pointer">
          <div className="flex items-center justify-center gap-2 rounded-xl border bg-card px-4 py-3 text-sm font-medium transition-colors hover:bg-muted">
            <ImagePlus className="size-4" />
            Choose photos
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileInputChange}
            className="hidden"
            disabled={disabled}
          />
        </label>
        <label className="flex-1 cursor-pointer">
          <div className="flex items-center justify-center gap-2 rounded-xl border bg-card px-4 py-3 text-sm font-medium transition-colors hover:bg-muted">
            📷 Take photo
          </div>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileInputChange}
            className="hidden"
            disabled={disabled}
          />
        </label>
      </div>

      {/* Desktop drag-drop zone (hidden on mobile) */}
      <section
        data-slot="photo-upload-dropzone"
        data-drag-over={isDraggingOver ? 'true' : undefined}
        aria-label="Photo drop zone"
        className={cn(
          'hidden md:flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed bg-card px-4 py-6 text-center transition-colors',
          isDraggingOver
            ? 'border-primary bg-primary/5'
            : 'border-muted-foreground/25 hover:border-muted-foreground/50',
        )}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <ImagePlus
          className={cn('size-6', isDraggingOver ? 'text-primary' : 'text-muted-foreground')}
          aria-hidden
        />
        <p className="text-sm text-muted-foreground">or drag and drop photos here</p>
      </section>

      {staged.length > 0 ? (
        <div className="flex flex-col gap-3 rounded-xl border bg-card p-3">
          <header className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {staged.length} ready to upload{staged.length === 1 ? '' : 's'}
            </span>
            {progress ? (
              <span>
                Uploading {progress.done} / {progress.total}
              </span>
            ) : null}
          </header>

          <ul className="flex flex-col gap-2">
            {staged.map((entry) => (
              <li
                key={entry.key}
                className="flex items-center gap-3 rounded-lg border bg-background p-2"
                data-slot="staged-photo"
              >
                <div className="size-16 shrink-0 overflow-hidden rounded-md bg-muted">
                  {/* biome-ignore lint/performance/noImgElement: blob-URL preview */}
                  <img
                    src={entry.previewUrl}
                    alt=""
                    className="size-full object-cover"
                    aria-hidden
                  />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-sm" title={entry.file.name}>
                    {entry.file.name}
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <PhotoTagSelect
                      value={entry.tag}
                      onChange={(tag) => updateStaged(entry.key, { tag })}
                      disabled={disabled}
                      ariaLabel={`Tag for ${entry.file.name}`}
                    />
                    <Label className="sr-only" htmlFor={`cap-${entry.key}`}>
                      Caption
                    </Label>
                    <Input
                      id={`cap-${entry.key}`}
                      className={cn(
                        'h-8 flex-1 text-sm',
                        entry.tag === 'concern' && 'border-red-300 ring-1 ring-red-200',
                      )}
                      placeholder={
                        entry.tag === 'concern' ? 'Describe the issue...' : 'Caption (optional)'
                      }
                      maxLength={500}
                      value={entry.caption}
                      onChange={(e) => updateStaged(entry.key, { caption: e.target.value })}
                      disabled={disabled}
                    />
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeStaged(entry.key)}
                  disabled={disabled}
                  aria-label={`Remove ${entry.file.name}`}
                >
                  <X className="size-4" />
                </Button>
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-end gap-2">
            {/* Hidden debug: tag counts so tests can grep data attributes. */}
            <span className="sr-only" data-slot="photo-tag-options" data-tags={photoTags.join(',')}>
              {photoTags.map((t) => photoTagLabels[t]).join(', ')}
            </span>
            <Button type="button" onClick={handleUpload} disabled={disabled}>
              {pending ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  Uploading…
                </>
              ) : (
                <>
                  <Upload className="size-3.5" aria-hidden />
                  Upload {staged.length} {staged.length === 1 ? 'photo' : 'photos'}
                </>
              )}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
