'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { archiveWorklogEntryAction } from './actions';

export function ArchiveButton({ id }: { id: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => {
        if (!confirm('Archive this entry?')) return;
        startTransition(async () => {
          const res = await archiveWorklogEntryAction(id);
          if (res.ok) {
            toast.success('Archived.');
            router.refresh();
          } else {
            toast.error(res.error);
          }
        });
      }}
      className="text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
      aria-label="Archive"
    >
      archive
    </button>
  );
}
