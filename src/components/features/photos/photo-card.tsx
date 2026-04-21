'use client';

/**
 * Thumbnail for a single photo inside the gallery grid.
 *
 * Click opens a shadcn Dialog lightbox with the signed URL at its natural
 * size (capped by viewport). The card itself handles the delete affordance
 * so the gallery component stays a simple loop.
 *
 * Henry integration:
 * - "Henry thinks: X" pill appears when ai_tag differs from the canonical
 *   tag and the photo has been processed. One tap promotes it.
 * - Quality warnings (blur / too dark / low contrast) show as a small
 *   badge so the operator knows to retake before sharing.
 * - If the caption is Henry's (caption_source = 'ai'), we show a tiny
 *   "by Henry" indicator.
 */

import { AlertTriangle, ImageOff, Sparkles } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { PhotoQualityFlags, PhotoWithUrl } from '@/lib/db/queries/photos';
import { cn } from '@/lib/utils';
import { type PhotoTag, photoTagLabels } from '@/lib/validators/photo';
import { acceptAiTagAction } from '@/server/actions/photos';
import { DeletePhotoButton } from './delete-photo-button';
import { PhotoFavoriteButton } from './photo-favorite-button';

const TAG_CLASS: Record<PhotoTag, string> = {
  before: 'bg-sky-100 text-sky-800 border-sky-200 hover:bg-sky-100',
  after: 'bg-emerald-100 text-emerald-800 border-emerald-200 hover:bg-emerald-100',
  progress: 'bg-amber-100 text-amber-800 border-amber-200 hover:bg-amber-100',
  damage: 'bg-orange-100 text-orange-800 border-orange-200 hover:bg-orange-100',
  materials: 'bg-stone-100 text-stone-800 border-stone-200 hover:bg-stone-100',
  equipment: 'bg-zinc-100 text-zinc-800 border-zinc-200 hover:bg-zinc-100',
  serial: 'bg-violet-100 text-violet-800 border-violet-200 hover:bg-violet-100',
  concern: 'bg-red-100 text-red-800 border-red-300 hover:bg-red-100',
  other: 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-100',
};

function qualityWarning(flags: PhotoQualityFlags): string | null {
  const issues: string[] = [];
  if (flags.blurry) issues.push('blurry');
  if (flags.too_dark) issues.push('dark');
  if (flags.low_contrast) issues.push('low contrast');
  if (issues.length === 0) return null;
  return issues.join(' · ');
}

export function PhotoCard({
  photo,
  tenantJobTypes = [],
}: {
  photo: PhotoWithUrl;
  tenantJobTypes?: string[];
}) {
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  const [pending, startTransition] = useTransition();

  const caption = photo.caption?.trim() ?? '';
  const hasUrl = photo.url && !broken;

  const aiSuggestionVisible =
    photo.ai_tag &&
    photo.ai_tag !== photo.tag &&
    // Only show as a suggestion if the user hasn't made an explicit choice
    // yet (ie. canonical tag is still 'other'). Respects operator intent.
    photo.tag === 'other';

  const confidence = photo.ai_tag_confidence ?? 0;
  const qualityNote = qualityWarning(photo.quality_flags ?? {});
  const captionByHenry = photo.caption_source === 'ai' && caption.length > 0;

  const acceptSuggestion = () => {
    startTransition(async () => {
      const result = await acceptAiTagAction(photo.id);
      if (result.ok) {
        toast.success(`Set tag to ${photoTagLabels[photo.ai_tag as PhotoTag]}`);
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <figure
      className={cn(
        'group relative overflow-hidden rounded-xl border bg-card',
        photo.tag === 'concern' && 'border-2 border-red-400 ring-1 ring-red-200',
      )}
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

      <div className="absolute left-2 top-2 flex flex-col gap-1">
        <Badge variant="outline" className={cn('font-medium border', TAG_CLASS[photo.tag])}>
          {photoTagLabels[photo.tag]}
        </Badge>
        {aiSuggestionVisible ? (
          <button
            type="button"
            onClick={acceptSuggestion}
            disabled={pending}
            className="flex items-center gap-1 rounded-md border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 shadow-sm transition-colors hover:bg-violet-100 disabled:opacity-50 dark:border-violet-900/50 dark:bg-violet-950 dark:text-violet-300"
            title={`Tap to accept Henry's suggestion (${Math.round(confidence * 100)}% confident)`}
          >
            <Sparkles className="size-3" aria-hidden />
            Henry: {photoTagLabels[photo.ai_tag as PhotoTag]}
            <span className="opacity-60">{Math.round(confidence * 100)}%</span>
          </button>
        ) : null}
        {qualityNote ? (
          <span
            className="flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 shadow-sm dark:border-amber-900/50 dark:bg-amber-950 dark:text-amber-300"
            title={`Quality issue: ${qualityNote}`}
          >
            <AlertTriangle className="size-3" aria-hidden />
            {qualityNote}
          </span>
        ) : null}
      </div>
      <div className="absolute right-2 top-2 flex items-center gap-1 opacity-80 transition-opacity group-hover:opacity-100">
        <PhotoFavoriteButton
          photoId={photo.id}
          isFavorite={photo.is_favorite}
          jobType={photo.job_type}
          suggestedJobTypes={tenantJobTypes}
        />
        <DeletePhotoButton photoId={photo.id} />
      </div>
      {caption ? (
        <figcaption
          className="flex items-center gap-1 truncate border-t bg-card/95 px-3 py-2 text-xs text-muted-foreground"
          title={caption}
        >
          {captionByHenry ? (
            <Sparkles className="size-3 shrink-0 text-violet-500" aria-label="Caption by Henry" />
          ) : null}
          <span className="truncate">{caption}</span>
        </figcaption>
      ) : null}
    </figure>
  );
}
