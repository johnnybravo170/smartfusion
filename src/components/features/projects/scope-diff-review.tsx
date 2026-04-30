/**
 * Server-side wrapper for the diff review surface. Loads the current
 * unsent-changes diff and hands off to a client component that
 * renders the per-change list + revert actions.
 *
 * Opened from the unsent-changes chip via `?review=diff` on the
 * project page.
 */

import { getUnsentDiff } from '@/lib/db/queries/project-scope-diff';
import { ScopeDiffReviewClient } from './scope-diff-review-client';

export async function ScopeDiffReview({ projectId }: { projectId: string }) {
  const diff = await getUnsentDiff(projectId);
  return <ScopeDiffReviewClient projectId={projectId} initialDiff={diff} />;
}
