'use client';

/**
 * Public portal photo gallery — homeowner-facing. Photos are passed in
 * grouped-by-tag from the page server component. Each tag gets its own
 * section header and a responsive grid of thumbnails. behind_wall is
 * collapsible and starts closed because it's reference material for
 * future contractors / repairs / resale, not the day-to-day update
 * surface.
 *
 * Click a thumbnail to open a fullscreen lightbox at natural size
 * (capped by viewport).
 */

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  PORTAL_PHOTO_TAG_DISPLAY_ORDER,
  type PortalPhotoTag,
  portalPhotoTagLabels,
} from '@/lib/validators/portal-photo';

export type PortalGalleryPhoto = {
  id: string;
  url: string;
  caption: string | null;
  tags: PortalPhotoTag[];
};

const COLLAPSIBLE_TAGS: ReadonlySet<PortalPhotoTag> = new Set(['behind_wall']);

const TAG_DESCRIPTIONS: Partial<Record<PortalPhotoTag, string>> = {
  behind_wall:
    'A permanent record of what is behind the walls. Useful for future repairs, renovations, resale, and insurance.',
  issue: 'Issues we documented during the job.',
};

export function PortalPhotoGallery({ photos }: { photos: PortalGalleryPhoto[] }) {
  const [openPhoto, setOpenPhoto] = useState<PortalGalleryPhoto | null>(null);
  const [behindWallOpen, setBehindWallOpen] = useState(false);

  if (photos.length === 0) return null;

  // Bucket each photo into ALL of its tags (a photo with both 'progress'
  // and 'completion' shows in both sections).
  const buckets = new Map<PortalPhotoTag, PortalGalleryPhoto[]>();
  for (const photo of photos) {
    for (const tag of photo.tags) {
      const existing = buckets.get(tag) ?? [];
      existing.push(photo);
      buckets.set(tag, existing);
    }
  }

  const orderedTags = PORTAL_PHOTO_TAG_DISPLAY_ORDER.filter(
    (t) => (buckets.get(t)?.length ?? 0) > 0,
  );

  return (
    <section className="space-y-6">
      <h2 className="text-base font-semibold">Photos</h2>

      {orderedTags.map((tag) => {
        const bucket = buckets.get(tag) ?? [];
        const collapsible = COLLAPSIBLE_TAGS.has(tag);
        const isOpen = !collapsible || (tag === 'behind_wall' ? behindWallOpen : true);
        const description = TAG_DESCRIPTIONS[tag];

        return (
          <div key={tag} className="rounded-lg border bg-card">
            <button
              type="button"
              className={cn(
                'flex w-full items-center justify-between gap-2 px-4 py-3 text-left',
                !collapsible && 'cursor-default',
              )}
              onClick={() => {
                if (tag === 'behind_wall') setBehindWallOpen((v) => !v);
              }}
              aria-expanded={collapsible ? isOpen : undefined}
              disabled={!collapsible}
            >
              <div>
                <h3 className="text-sm font-semibold">
                  {portalPhotoTagLabels[tag]}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {bucket.length}
                  </span>
                </h3>
                {description ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
                ) : null}
              </div>
              {collapsible ? (
                isOpen ? (
                  <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
                ) : (
                  <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                )
              ) : null}
            </button>

            {isOpen ? (
              <div className="grid grid-cols-2 gap-2 p-3 pt-0 sm:grid-cols-3 md:grid-cols-4">
                {bucket.map((photo) => (
                  <button
                    key={`${tag}-${photo.id}`}
                    type="button"
                    className="block aspect-square overflow-hidden rounded-md border bg-muted/30"
                    onClick={() => setOpenPhoto(photo)}
                    aria-label={photo.caption || `Open photo ${photo.id}`}
                  >
                    {/* biome-ignore lint/performance/noImgElement: signed URLs bypass next/image */}
                    <img
                      src={photo.url}
                      alt={photo.caption ?? portalPhotoTagLabels[tag]}
                      loading="lazy"
                      className="size-full object-cover transition-transform duration-200 hover:scale-[1.03]"
                    />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}

      <Dialog open={!!openPhoto} onOpenChange={(o) => !o && setOpenPhoto(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogTitle className="sr-only">{openPhoto?.caption ?? 'Photo'}</DialogTitle>
          {openPhoto ? (
            <>
              {/* biome-ignore lint/performance/noImgElement: signed URLs bypass next/image */}
              <img
                src={openPhoto.url}
                alt={openPhoto.caption ?? 'Photo'}
                className="max-h-[70vh] w-full rounded-md object-contain"
              />
              {openPhoto.caption ? (
                <p className="text-sm text-muted-foreground">{openPhoto.caption}</p>
              ) : null}
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
