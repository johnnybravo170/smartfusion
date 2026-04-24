'use client';

/**
 * Click-to-zoom photo strip for the customer-facing estimate.
 * Replaces the previous "open image in new tab" behavior with an
 * in-page lightbox that supports keyboard nav (← →, Esc) and
 * tap-anywhere-to-close on mobile.
 */

import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

export function EstimatePhotoLightbox({ urls }: { urls: string[] }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const close = useCallback(() => setActiveIndex(null), []);
  const next = useCallback(
    () => setActiveIndex((i) => (i == null ? null : (i + 1) % urls.length)),
    [urls.length],
  );
  const prev = useCallback(
    () => setActiveIndex((i) => (i == null ? null : (i - 1 + urls.length) % urls.length)),
    [urls.length],
  );

  useEffect(() => {
    if (activeIndex == null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
    }
    window.addEventListener('keydown', onKey);
    // Lock body scroll while open
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [activeIndex, close, next, prev]);

  if (urls.length === 0) return null;

  return (
    <>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {urls.map((url, i) => (
          <button
            type="button"
            key={url}
            onClick={() => setActiveIndex(i)}
            className="block h-14 w-14 overflow-hidden rounded-md border transition hover:opacity-80"
            aria-label={`Open photo ${i + 1} of ${urls.length}`}
          >
            {/* biome-ignore lint/performance/noImgElement: signed URLs bypass next/image */}
            <img src={url} alt="" className="h-full w-full object-cover" />
          </button>
        ))}
      </div>

      {activeIndex != null ? (
        // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled at window level above
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          {urls.length > 1 ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                prev();
              }}
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
              aria-label="Previous photo"
            >
              <ChevronLeft className="size-6" />
            </button>
          ) : null}

          {/* biome-ignore lint/performance/noImgElement: signed URLs bypass next/image */}
          <img
            src={urls[activeIndex]}
            alt=""
            className="max-h-full max-w-full rounded-md object-contain"
          />

          {urls.length > 1 ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                next();
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
              aria-label="Next photo"
            >
              <ChevronRight className="size-6" />
            </button>
          ) : null}

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              close();
            }}
            className="absolute right-3 top-3 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>

          {urls.length > 1 ? (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-xs text-white">
              {activeIndex + 1} / {urls.length}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
