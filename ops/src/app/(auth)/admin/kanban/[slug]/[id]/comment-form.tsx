'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { commentCardAction } from '../../actions';

export function CommentForm({ id, slug }: { id: string; slug: string }) {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [isPending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    startTransition(async () => {
      const r = await commentCardAction(id, slug, body.trim());
      if (r.ok) {
        setBody('');
        toast.success('Comment added.');
        router.refresh();
      } else {
        toast.error(r.error);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2 rounded-md border border-[var(--border)] p-3">
      <textarea
        rows={2}
        placeholder="Add a comment…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className="w-full rounded border border-[var(--border)] bg-white px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-[var(--ring)]"
      />
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={isPending || !body.trim()}
          className="rounded bg-[var(--primary)] px-2 py-1 text-xs font-medium text-[var(--primary-foreground)] disabled:opacity-50"
        >
          {isPending ? 'Adding…' : 'Add comment'}
        </button>
      </div>
    </form>
  );
}
