'use client';

import { X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';

type Photo = {
  id: string;
  url: string;
  caption: string | null;
  job_type: string | null;
};

export function ShowcaseGallery({ photos, jobTypes }: { photos: Photo[]; jobTypes: string[] }) {
  const [filter, setFilter] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<Photo | null>(null);

  const filtered = useMemo(
    () => (filter ? photos.filter((p) => p.job_type === filter) : photos),
    [photos, filter],
  );

  return (
    <>
      {jobTypes.length > 0 ? (
        <div className="mb-6 flex flex-wrap justify-center gap-2">
          <Chip active={filter === null} onClick={() => setFilter(null)}>
            All
          </Chip>
          {jobTypes.map((t) => (
            <Chip key={t} active={filter === t} onClick={() => setFilter(t)}>
              {t}
            </Chip>
          ))}
        </div>
      ) : null}

      <div className="columns-2 gap-3 sm:columns-3 lg:columns-4 [&>*]:mb-3">
        {filtered.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setLightbox(p)}
            className="block w-full overflow-hidden rounded-lg border bg-card"
          >
            {/* biome-ignore lint/performance/noImgElement: signed URLs bypass next/image */}
            <img
              src={p.url}
              alt={p.caption ?? p.job_type ?? ''}
              loading="lazy"
              className="w-full object-cover transition-transform duration-200 hover:scale-[1.02]"
            />
          </button>
        ))}
      </div>

      {lightbox ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
          onClick={() => setLightbox(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setLightbox(null);
          }}
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            aria-label="Close"
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            onClick={(e) => {
              e.stopPropagation();
              setLightbox(null);
            }}
          >
            <X className="size-5" />
          </button>
          {/* biome-ignore lint/performance/noImgElement: signed URLs bypass next/image */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: onClick here only stops bubbling to the backdrop */}
          <img
            src={lightbox.url}
            alt={lightbox.caption ?? ''}
            className="max-h-[85vh] max-w-full rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          {lightbox.caption ? (
            <p className="absolute inset-x-0 bottom-4 px-4 text-center text-sm text-white/90">
              {lightbox.caption}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-foreground bg-foreground text-background'
          : 'border-border bg-background text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}
