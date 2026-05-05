'use client';

import { useTransition } from 'react';
import { toast } from 'sonner';
import { deleteBoardSessionAction } from './actions';

/**
 * Hard-delete a session and all its children (cascade in Postgres).
 * Confirms first; the session has accepted decisions tied to it (via
 * tags) but those won't cascade — accepted decisions live in
 * ops.decisions independently and will lose their back-reference. So we
 * gate hard-delete on non-accepted/non-edited statuses.
 */
export function DeleteSessionButton({
  sessionId,
  status,
  redirectTo,
  variant = 'icon',
}: {
  sessionId: string;
  status: string;
  redirectTo?: string | null;
  variant?: 'icon' | 'button';
}) {
  const [isPending, startTransition] = useTransition();

  const isPromoted = status === 'accepted' || status === 'edited';

  function onClick(): void {
    if (isPromoted) {
      toast.error(
        'This session was accepted; deleting would orphan the spawned decision and kanban cards.',
      );
      return;
    }
    if (
      !confirm(
        `Delete session ${sessionId.slice(0, 8)}? This wipes its transcript, cruxes, positions, and proposed decision.`,
      )
    )
      return;
    startTransition(async () => {
      const r = await deleteBoardSessionAction(sessionId, redirectTo ?? null);
      if (!r.ok) toast.error(r.error);
      else toast.success('Session deleted');
    });
  }

  if (variant === 'icon') {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={isPending || isPromoted}
        title={isPromoted ? 'Cannot delete an accepted session' : 'Delete session'}
        aria-label="Delete session"
        className="rounded border border-transparent px-1.5 py-0.5 text-xs text-[var(--muted-foreground)] hover:border-red-300 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30"
      >
        🗑
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPending || isPromoted}
      className="rounded-md border border-red-300 px-3 py-1.5 text-xs text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30"
    >
      {isPending ? 'Deleting...' : 'Delete session'}
    </button>
  );
}
