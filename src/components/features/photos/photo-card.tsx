'use client';

/**
 * Thumbnail for a single photo inside the gallery grid.
 *
 * Click opens a shadcn Dialog lightbox with the signed URL at its natural
 * size (capped by viewport). The card itself handles the delete affordance
 * so the gallery component stays a simple loop.
 */

import { ImageOff } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { PhotoWithUrl } from '@/lib/db/queries/photos';
import { cn } from '@/lib/utils';
import { type PhotoTag, photoTagLabels } from '@/lib/validators/photo';
import { DeletePhotoButton } from './delete-photo-button';

const TAG_CLASS: Record<PhotoTag, string> = {
  before: 'bg-sky-100 text-sky-800 border-sky-200 hover:bg-sky-100',
  after: 'bg-emerald-100 text-emerald-800 border-emerald-200 hover:bg-emerald-100',
  progress: 'bg-amber-100 text-amber-800 border-amber-200 hover:bg-amber-100',
  other: 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-100',
};

export function PhotoCard({ photo }: { photo: PhotoWithUrl }) {
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);

  const caption = photo.caption?.trim() ?? '';
  const hasUrl = photo.url && !broken;

  return (
    <figure
      className="group relative overflow-hidden rounded-xl border bg-card"
      data-slot="photo-card"
      data-photo-id={photo.id}
    >
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <button
            type="button"
            className="block aspect-square w-full overflow-hidden bg-muted/30 text-left"
            aria-label={caption ? `Open photo: ${caption}` : 'Open photo'}
          >
            {hasUrl ? (
              // biome-ignore lint/performance/noImgElement: signed URLs bypass next/image optimizer
              <img
                src={photo.url as string}
                alt={caption || photoTagLabels[photo.tag]}
                className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                loading="lazy"
                onError={() => setBroken(true)}
              />
            ) : (
              <div className="flex size-full items-center justify-center text-muted-foreground">
                <ImageOff className="size-6" aria-hidden />
              </div>
            )}
          </button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{photoTagLabels[photo.tag]}</DialogTitle>
            <DialogDescription>{caption || 'No caption.'}</DialogDescription>
          </DialogHeader>
          {hasUrl ? (
            // biome-ignore lint/performance/noImgElement: signed URLs bypass next/image optimizer
            <img
              src={photo.url as string}
              alt={caption || photoTagLabels[photo.tag]}
              className="max-h-[70vh] w-full rounded-md object-contain"
            />
          ) : (
            <div className="flex h-48 items-center justify-center text-muted-foreground">
              <ImageOff className="size-6" aria-hidden />
              <span className="ml-2 text-sm">Image unavailable.</span>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <div className="absolute left-2 top-2">
        <Badge variant="outline" className={cn('font-medium border', TAG_CLASS[photo.tag])}>
          {photoTagLabels[photo.tag]}
        </Badge>
      </div>
      <div className="absolute right-2 top-2 opacity-80 transition-opacity group-hover:opacity-100">
        <DeletePhotoButton photoId={photo.id} />
      </div>
      {caption ? (
        <figcaption
          className="truncate border-t bg-card/95 px-3 py-2 text-xs text-muted-foreground"
          title={caption}
        >
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}
