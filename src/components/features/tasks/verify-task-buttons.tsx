'use client';

/**
 * Owner-only inline verify / reject controls for a `done` task. Drops into
 * the "To Verify" dashboard list and the project task list (next to any
 * row showing status='done'). Reject prompts for an optional note via
 * the browser prompt — intentionally lo-fi for v1; an inline form can
 * replace it once we see how often owners actually use the explanation
 * field.
 */

import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { rejectVerificationAction, verifyTaskAction } from '@/server/actions/tasks';

export function VerifyTaskButtons({
  taskId,
  compact = false,
}: {
  taskId: string;
  compact?: boolean;
}) {
  const [pending, startTransition] = useTransition();

  function onVerify() {
    startTransition(async () => {
      const res = await verifyTaskAction(taskId);
      if (!res.ok) toast.error(res.error);
      else toast.success('Verified.');
    });
  }

  function onReject() {
    const note = window.prompt('What needs more work? (optional)') ?? undefined;
    startTransition(async () => {
      const res = await rejectVerificationAction(taskId, note ?? undefined);
      if (!res.ok) toast.error(res.error);
      else toast.success('Sent back to crew.');
    });
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button
        type="button"
        size={compact ? 'sm' : 'default'}
        variant="default"
        onClick={onVerify}
        disabled={pending}
      >
        Verify
      </Button>
      <button
        type="button"
        onClick={onReject}
        disabled={pending}
        className="text-xs text-muted-foreground underline hover:text-foreground disabled:opacity-50"
      >
        Reject
      </button>
    </div>
  );
}
