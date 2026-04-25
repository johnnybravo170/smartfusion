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

import { AlertTriangle, Check, ImageOff, Sparkles } from 'lucide-react';
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
import {
  applyHenryPortalSuggestionAction,
  enrichPhotoForPortalAction,
} from '@/server/actions/portal-photos';
import { PhotoPortalButton } from '../portal/photo-portal-button';
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
  phases = [],
  selectMode = false,
  selected = false,
  onToggleSelect,
}: {
  photo: PhotoWithUrl;
  tenantJobTypes?: string[];
  /** Optional phase list for the "Pin to phase" picker on the portal popover. */
  phases?: Array<{ id: string; name: string }>;
  /** When true, clicks toggle selection instead of opening the lightbox. */
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (photoId: string) => void;
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

  // Portfolio hint: surfaced only when Henry is confident AND the operator
  // hasn't already favorited it. Once favorited the sparkle button carries
  // the weight, so the chip would be noise.
  const showcaseHintVisible = !photo.is_favorite && (photo.ai_showcase_score ?? 0) >= 0.75;
  const showcaseReason = photo.ai_showcase_reason?.trim() ?? '';

  // Henry's portal suggestion appears when:
  //   - We have suggestions (ai_portal_tags non-empty)
  //   - Operator hasn't tagged for the portal yet (portal_tags empty)
  // Otherwise: a small "ask Henry" prompt when neither suggestions nor
  // portal_tags exist, so the operator can request one with a click.
  const aiPortalTags = photo.ai_portal_tags ?? [];
  const portalTags = photo.portal_tags ?? [];
  const henrySuggestionVisible =
    photo.project_id && aiPortalTags.length > 0 && portalTags.length === 0;
  const henryAskVisible =
    photo.project_id && aiPortalTags.length === 0 && portalTags.length === 0 && !selectMode;

  const applyHenry = () => {
    if (!photo.project_id) return;
    startTransition(async () => {
      const result = await applyHenryPortalSuggestionAction(photo.id, photo.project_id as string);
      if (result.ok) {
        toast.success(`Applied Henry's portal tags`);
      } else {
        toast.error(result.error);
      }
    });
  };
  const askHenry = () => {
    if (!photo.project_id) return;
    startTransition(async () => {
      const result = await enrichPhotoForPortalAction(photo.id, photo.project_id as string);
      if (result.ok) {
        const count = result.portalTags.length;
        toast.success(
          count > 0
            ? `Henry suggested ${count} tag${count === 1 ? '' : 's'}`
            : 'Henry had no suggestion',
        );
      } else {
        toast.error(result.error);
      }
    });
  };

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

  // In selectMode, the thumbnail click toggles selection instead of
  // opening the lightbox. The portal/favorite/delete overlay buttons
  // stay reachable so the operator can still tweak a single photo
  // without leaving select mode.
  function onThumbClick(e: React.MouseEvent) {
    if (!selectMode) return;
    e.preventDefault();
    e.stopPropagation();
    onToggleSelect?.(photo.id);
  }

  return (
    <figure
      className={cn(
        'group relative overflow-hidden rounded-xl border bg-card',
        photo.tag === 'concern' && 'border-2 border-red-400 ring-1 ring-red-200',
        selected && 'ring-2 ring-primary',
      )}
      data-slot="photo-card"
      data-photo-id={photo.id}
    >
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <button
            type="button"
            className="block aspect-square w-full overflow-hidden bg-muted/30 text-left"
            aria-label={
              selectMode
                ? selected
                  ? 'Deselect photo'
                  : 'Select photo'
                : caption
                  ? `Open photo: ${caption}`
                  : 'Open photo'
            }
            onClick={onThumbClick}
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

      {/* Selection check overlay — only in selectMode */}
      {selectMode ? (
        <div
          className={cn(
            'absolute right-2 top-2 z-10 flex size-7 items-center justify-center rounded-full border-2 bg-background/95 shadow-sm transition-colors',
            selected
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-muted-foreground/40',
          )}
        >
          {selected ? <Check className="size-4" /> : null}
        </div>
      ) : null}

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
        {henrySuggestionVisible ? (
          <button
            type="button"
            onClick={applyHenry}
            disabled={pending}
            className="flex items-center gap-1 rounded-md border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 shadow-sm transition-colors hover:bg-violet-100 disabled:opacity-50 dark:border-violet-900/50 dark:bg-violet-950 dark:text-violet-300"
            title={photo.ai_portal_caption ?? "Apply Henry's portal tags"}
          >
            <Sparkles className="size-3" aria-hidden />
            Henry: {aiPortalTags.slice(0, 2).join(', ')}
            {aiPortalTags.length > 2 ? ` +${aiPortalTags.length - 2}` : ''}
          </button>
        ) : null}
        {henryAskVisible ? (
          <button
            type="button"
            onClick={askHenry}
            disabled={pending}
            className="flex items-center gap-1 rounded-md border border-dashed border-violet-200 bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 hover:bg-violet-50 disabled:opacity-50 dark:border-violet-900/50 dark:hover:bg-violet-950"
            title="Ask Henry to suggest portal tags"
          >
            <Sparkles className="size-3" aria-hidden />
            Ask Henry
          </button>
        ) : null}
        {showcaseHintVisible ? (
          <span
            className="flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 shadow-sm dark:border-amber-900/50 dark:bg-amber-950 dark:text-amber-300"
            title={showcaseReason || 'Henry thinks this is a great shot.'}
          >
            <Sparkles className="size-3" aria-hidden />
            Great shot
          </span>
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
        {photo.project_id ? (
          <PhotoPortalButton
            photoId={photo.id}
            projectId={photo.project_id}
            initialTags={photo.portal_tags ?? []}
            initialClientVisible={photo.client_visible ?? true}
            initialPhaseId={photo.phase_id ?? null}
            phases={phases}
          />
        ) : null}
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
