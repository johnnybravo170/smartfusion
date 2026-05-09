'use client';

/**
 * "Auto-link dependencies" button for the operator's Schedule tab.
 *
 * Wipes the project's existing project_schedule_dependencies rows and
 * rebuilds them via phase-aware bucketing — every task in phase N
 * depends on every task in the previous populated phase. Used when the
 * operator wants to reset to the canonical sequence, e.g. after
 * manually moving things around or for a project bootstrapped before
 * phase-aware edges existed.
 *
 * Deterministic, single-action — lives as a UI button rather than a
 * Henry tool to keep Henry's tool surface focused on conversational
 * decisions.
 */

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { regenerateScheduleDependenciesAction } from '@/server/actions/project-schedule';

export function ScheduleRegenerateDepsButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const handle = () => {
    if (
      !confirm(
        'Auto-link every task to the canonical phase order? Any manual "Depends on" edits will be reset.',
      )
    ) {
      return;
    }
    startTransition(async () => {
      const res = await regenerateScheduleDependenciesAction({ projectId });
      if (!res.ok) {
        alert(`Could not auto-link: ${res.error}`);
        return;
      }
      router.refresh();
    });
  };

  return (
    <Button type="button" variant="outline" size="sm" onClick={handle} disabled={pending}>
      {pending ? 'Linking…' : 'Auto-link dependencies'}
    </Button>
  );
}
