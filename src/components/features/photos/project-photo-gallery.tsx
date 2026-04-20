/**
 * Project-scoped photo gallery — server component.
 *
 * Mirrors PhotoGallery but queries by project_id. Reuses PhotoCard for the
 * tile layout so any future improvements to the card flow through to both.
 */

import { ImagePlus } from 'lucide-react';
import { listPhotosByProject } from '@/lib/db/queries/photos';
import { PhotoCard } from './photo-card';

export async function ProjectPhotoGallery({ projectId }: { projectId: string }) {
  const photos = await listPhotosByProject(projectId);

  if (photos.length === 0) {
    return (
      <div
        className="flex flex-col items-center gap-2 rounded-xl border border-dashed bg-card px-4 py-8 text-center"
        data-slot="project-photo-gallery-empty"
      >
        <ImagePlus className="size-6 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">No photos for this project yet.</p>
        <p className="text-xs text-muted-foreground">Upload some above to get started.</p>
      </div>
    );
  }

  return (
    <div
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4"
      data-slot="project-photo-gallery"
      data-count={photos.length}
    >
      {photos.map((photo) => (
        <PhotoCard key={photo.id} photo={photo} />
      ))}
    </div>
  );
}
