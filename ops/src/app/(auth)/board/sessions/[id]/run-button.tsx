'use client';

import { useTransition } from 'react';
import { toast } from 'sonner';
import { runBoardSessionAction } from '../../actions';

export function RunButton({ sessionId }: { sessionId: string }) {
  const [isPending, startTransition] = useTransition();

  function onClick(): void {
    startTransition(async () => {
      const r = await runBoardSessionAction(sessionId);
      if (r.ok) toast.success('Session running');
      else toast.error(r.error);
    });
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPending}
      className="rounded-md bg-[var(--foreground)] px-4 py-2 text-sm font-medium text-[var(--background)] disabled:opacity-50"
    >
      {isPending ? 'Starting...' : 'Run discussion'}
    </button>
  );
}
