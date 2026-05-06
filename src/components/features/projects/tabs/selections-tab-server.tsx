import { SelectionFormDialog } from '@/components/features/portal/selection-form-dialog';
import { SelectionList } from '@/components/features/portal/selection-list';
import type { GalleryPickerPhoto } from '@/components/features/portal/selection-photo-picker';
import { CustomerIdeasSection } from '@/components/features/projects/customer-ideas-section';
import { listPhotosByProject } from '@/lib/db/queries/photos';
import {
  groupSelectionsByRoom,
  listSelectionsForProject,
} from '@/lib/db/queries/project-selections';
import { signIdeaBoardImageUrls } from '@/lib/storage/idea-board';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import type { IdeaBoardItem } from '@/server/actions/project-idea-board';

export default async function SelectionsTabServer({ projectId }: { projectId: string }) {
  const supabase = await createClient();

  const [selections, photos, ideaRowsRes] = await Promise.all([
    listSelectionsForProject(projectId),
    listPhotosByProject(projectId),
    supabase
      .from('project_idea_board_items')
      .select(
        'id, project_id, customer_id, kind, image_storage_path, source_url, thumbnail_url, title, notes, room, read_by_operator_at, promoted_to_selection_id, promoted_at, created_at',
      )
      .eq('project_id', projectId)
      .order('created_at', { ascending: false }),
  ]);
  const groups = groupSelectionsByRoom(selections);

  // Operator-side mark-read: opening the Selections tab counts as
  // "saw the new customer ideas." Fired here on render rather than a
  // client-side useEffect so it's robust to JS-disabled views and there's
  // no flicker between badge-on and badge-off. Mirrors the operator
  // Messages tab pattern.
  await supabase
    .from('project_idea_board_items')
    .update({ read_by_operator_at: new Date().toISOString() })
    .eq('project_id', projectId)
    .is('read_by_operator_at', null);

  const ideaItemsRaw = (ideaRowsRes.data ?? []) as IdeaBoardItem[];
  const ideaImagePaths = ideaItemsRaw
    .map((r) => r.image_storage_path)
    .filter((p): p is string => Boolean(p));
  // Use the admin client for signing — same convention as the customer-side
  // renderer, and avoids any RLS surprises on storage.objects.
  const admin = createAdminClient();
  const ideaSignedUrls = await signIdeaBoardImageUrls(admin, ideaImagePaths);
  const ideaItems: IdeaBoardItem[] = ideaItemsRaw.map((r) => ({
    ...r,
    image_url: r.image_storage_path ? (ideaSignedUrls.get(r.image_storage_path) ?? null) : null,
  }));

  // Pre-resolved signed URLs from listPhotosByProject — pass to the
  // photo-refs picker dialog. Filter to photos that have a signed URL
  // and belong to this project (project_id matches; deleted_at filters
  // already applied upstream).
  const galleryPhotos: GalleryPickerPhoto[] = photos
    .filter((p) => Boolean(p.url))
    .map((p) => ({
      id: p.id,
      storage_path: p.storage_path,
      url: p.url as string,
      caption: p.caption ?? null,
    }));

  return (
    <div className="space-y-6">
      <CustomerIdeasSection items={ideaItems} />

      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Selections</h2>
          <p className="text-sm text-muted-foreground">
            Per-room paint codes, tile, fixtures, hardware. The homeowner sees these on their portal
            and they get rolled into the final Home Record.
          </p>
        </div>
        <SelectionFormDialog projectId={projectId} />
      </div>
      <SelectionList groups={groups} projectId={projectId} galleryPhotos={galleryPhotos} />
    </div>
  );
}
