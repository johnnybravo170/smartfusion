/**
 * Photo gallery — server component.
 *
 * Loads photos for a single job, pairs each with a short-lived signed URL,
 * and renders them in a responsive grid. Client interactivity (lightbox,
 * delete) lives inside `PhotoCard`.
 */

import { ImagePlus } from 'lucide-react';
import { listPhotosByJob } from '@/lib/db/queries/photos';
import { PhotoCard } from './photo-card';

export async function PhotoGallery({ jobId }: { jobId: string }) {
  const photos = await listPhotosByJob(jobId);

  if (photos.length === 0) {
    return (
      <div
        className="flex flex-col items-center gap-2 rounded-xl border border-dashed bg-card px-4 py-8 text-center"
        data-slot="photo-gallery-empty"
      >
        <ImagePlus className="size-6 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">No photos for this job yet.</p>
        <p className="text-xs text-muted-foreground">Upload some above to get started.</p>
      </div>
    );
  }

  return (
    <div
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4"
      data-slot="photo-gallery"
      data-count={photos.length}
    >
      {photos.map((photo) => (
        <PhotoCard key={photo.id} photo={photo} />
      ))}
    </div>
  );
}
