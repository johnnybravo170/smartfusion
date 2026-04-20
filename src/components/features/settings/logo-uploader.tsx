'use client';

import { ImageIcon, Upload, X } from 'lucide-react';
import { useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { clearLogoAction, uploadLogoAction } from '@/server/actions/profile';

export function LogoUploader({ currentLogoUrl }: { currentLogoUrl: string | null }) {
  const [preview, setPreview] = useState<string | null>(currentLogoUrl);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function handlePick() {
    inputRef.current?.click();
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Optimistic preview
    const objectUrl = URL.createObjectURL(file);
    setPreview(objectUrl);

    startTransition(async () => {
      const form = new FormData();
      form.append('file', file);
      const result = await uploadLogoAction(form);
      if (result.ok) {
        toast.success('Logo uploaded.');
      } else {
        toast.error(result.error);
        setPreview(currentLogoUrl);
      }
      URL.revokeObjectURL(objectUrl);
    });
  }

  function handleRemove() {
    startTransition(async () => {
      const result = await clearLogoAction();
      if (result.ok) {
        toast.success('Logo removed.');
        setPreview(null);
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="flex items-start gap-4">
      <div className="flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
        {preview ? (
          // biome-ignore lint/performance/noImgElement: signed URL + local blob
          <img src={preview} alt="Business logo" className="size-full object-contain" />
        ) : (
          <ImageIcon className="size-8 text-muted-foreground" aria-hidden />
        )}
      </div>
      <div className="flex flex-col gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          onChange={handleFile}
          className="hidden"
        />
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={handlePick} disabled={pending}>
            <Upload className="mr-1.5 size-3.5" aria-hidden />
            {preview ? 'Replace' : 'Upload'}
          </Button>
          {preview ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleRemove}
              disabled={pending}
            >
              <X className="mr-1.5 size-3.5" aria-hidden />
              Remove
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          PNG, JPEG, WebP, or SVG. Up to 5 MB. Square or rectangular.
        </p>
      </div>
    </div>
  );
}
