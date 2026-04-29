/**
 * Server entry for the per-project team checklist. Loads the items + the
 * tenant's hide-completed window + the categories used previously on this
 * project, then hands off to the client component for the live UI.
 *
 * Used by:
 *  - Worker dashboard (`/w`) — defaults to the worker's last-billed project
 *  - Worker project page (`/w/projects/[id]`)
 *  - GC project page (when wired)
 */

import { getCurrentTenant } from '@/lib/auth/helpers';
import {
  getChecklistHideHours,
  listCategoriesForProject,
  listChecklistForProject,
} from '@/lib/db/queries/project-checklist';
import { getChecklistSignedUrls } from '@/lib/storage/project-checklist';
import { TeamChecklistClient } from './team-checklist-client';

export async function TeamChecklist({
  projectId,
  projectName,
  /** `card` (default) wraps in a titled Card. `bare` renders only the add
   * row + list — use when the parent already supplies a Card + header. */
  chrome = 'card',
}: {
  projectId: string;
  projectName?: string;
  chrome?: 'card' | 'bare';
}) {
  const tenant = await getCurrentTenant();
  if (!tenant) return null;

  const hideHours = await getChecklistHideHours(tenant.id);
  const [items, categories] = await Promise.all([
    listChecklistForProject(projectId, hideHours),
    listCategoriesForProject(projectId),
  ]);

  // Pre-sign photo thumbnails so the client doesn't need to round-trip.
  const photoPaths = items.map((i) => i.photo_storage_path).filter((p): p is string => !!p);
  const signedUrls = await getChecklistSignedUrls(photoPaths);
  const itemsWithUrls = items.map((i) => ({
    ...i,
    photo_url: i.photo_storage_path ? (signedUrls.get(i.photo_storage_path) ?? null) : null,
  }));

  return (
    <TeamChecklistClient
      projectId={projectId}
      projectName={projectName}
      chrome={chrome}
      initialItems={itemsWithUrls}
      knownCategories={categories}
    />
  );
}
