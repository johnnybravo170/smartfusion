'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { promoteIdeaToKanbanAction } from './actions';

const BOARDS = ['dev', 'marketing', 'research', 'ops'] as const;
const SIZES = [1, 2, 3, 5, 8, 13, 21] as const;
const PRIORITIES = [1, 2, 3, 4, 5] as const;

export function PromoteToKanbanForm({ ideaId }: { ideaId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [board, setBoard] = useState<(typeof BOARDS)[number]>('dev');
  const [size, setSize] = useState<number>(3);
  const [priority, setPriority] = useState<number>(3);
  const [isPending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const r = await promoteIdeaToKanbanAction(ideaId, {
        boardSlug: board,
        sizePoints: size,
        priority,
      });
      if (r.ok) {
        toast.success(`Promoted to kanban (${board}).`);
        setOpen(false);
        router.refresh();
      } else {
        toast.error(r.error);
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-foreground)] hover:opacity-90"
      >
        Promote to Kanban
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-[var(--border)] p-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-xs">
          <span className="block font-medium text-[var(--muted-foreground)]">Board</span>
          <select
            value={board}
            onChange={(e) => setBoard(e.target.value as (typeof BOARDS)[number])}
            className="w-full rounded-md border border-[var(--border)] bg-white px-2 py-1 text-sm"
          >
            {BOARDS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs">
          <span className="block font-medium text-[var(--muted-foreground)]">Size (points)</span>
          <select
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            className="w-full rounded-md border border-[var(--border)] bg-white px-2 py-1 text-sm"
          >
            {SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs">
          <span className="block font-medium text-[var(--muted-foreground)]">Priority</span>
          <select
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
            className="w-full rounded-md border border-[var(--border)] bg-white px-2 py-1 text-sm"
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={isPending}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-[var(--muted)]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-foreground)] disabled:opacity-50"
        >
          {isPending ? 'Promoting…' : 'Create card'}
        </button>
      </div>
    </form>
  );
}
