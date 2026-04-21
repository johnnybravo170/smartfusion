'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { revokeKeyAction } from './actions';

export function RevokeButton({ id }: { id: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => {
        const reason = prompt('Revocation reason (logged):');
        if (!reason) return;
        startTransition(async () => {
          const r = await revokeKeyAction(id, reason);
          if (r.ok) {
            toast.success('Revoked.');
            router.refresh();
          } else {
            toast.error(r.error);
          }
        });
      }}
      className="text-xs text-[var(--destructive)] hover:underline"
    >
      revoke
    </button>
  );
}
