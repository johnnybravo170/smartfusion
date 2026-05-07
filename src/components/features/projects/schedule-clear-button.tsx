'use client';

/**
 * "Clear schedule" button for the operator's Schedule tab.
 *
 * Soft-deletes every active task on the project so the GC can re-
 * bootstrap from a different source. Confirmation prompt keeps
 * accidental clicks from blowing away an in-progress schedule.
 */

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { clearProjectScheduleAction } from '@/server/actions/project-schedule';

export function ScheduleClearButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const handle = () => {
    if (!confirm('Clear the entire schedule? Tasks will be soft-deleted.')) return;
    startTransition(async () => {
      const res = await clearProjectScheduleAction(projectId);
      if (!res.ok) {
        alert(`Could not clear schedule: ${res.error}`);
        return;
      }
      router.refresh();
    });
  };

  return (
    <Button type="button" variant="outline" size="sm" onClick={handle} disabled={pending}>
      {pending ? 'Clearing…' : 'Clear & re-bootstrap'}
    </Button>
  );
}
