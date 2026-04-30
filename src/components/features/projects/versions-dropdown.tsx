/**
 * Server entry for the Versions dropdown — loads the chronological list
 * of every signed version of a project's scope and hands off to the
 * client component for the popover + read-only viewer modal.
 *
 * Hidden when the project has no signed versions (planning / draft
 * projects) — there's nothing meaningful to show.
 */

import { listProjectVersions } from '@/lib/db/queries/project-versions';
import { VersionsDropdownClient } from './versions-dropdown-client';

export async function VersionsDropdown({ projectId }: { projectId: string }) {
  const versions = await listProjectVersions(projectId);
  if (versions.length === 0) return null;
  return <VersionsDropdownClient projectId={projectId} versions={versions} />;
}
