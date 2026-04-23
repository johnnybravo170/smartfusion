'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { createCardAction } from '../actions';

type KanbanColumn = 'backlog' | 'todo' | 'doing' | 'blocked' | 'done';

export function NewCardForm({ boardSlug, column }: { boardSlug: string; column: KanbanColumn }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const [suggested, setSuggested] = useState('');
  const [isPending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const r = await createCardAction({
        boardSlug,
        title: title.trim(),
        column,
        body: body.trim() || null,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        suggested_agent: suggested.trim() || null,
      });
      if (r.ok) {
        setTitle('');
        setBody('');
        setTags('');
        setSuggested('');
        setOpen(false);
        toast.success('Card created.');
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
        className="w-full rounded-md border border-dashed border-[var(--border)] px-2 py-1.5 text-xs text-[var(--muted-foreground)] hover:border-[var(--foreground)] hover:text-[var(--foreground)]"
      >
        + New
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-1.5 rounded-md border border-[var(--border)] p-2">
      <input
        type="text"
        required
        placeholder="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full rounded border border-[var(--border)] bg-white px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-[var(--ring)]"
      />
      <textarea
        rows={2}
        placeholder="Body (optional)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className="w-full rounded border border-[var(--border)] bg-white px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-[var(--ring)]"
      />
      <input
        type="text"
        placeholder="tags,comma,separated"
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        className="w-full rounded border border-[var(--border)] bg-white px-2 py-1 text-xs outline-none"
      />
      <input
        type="text"
        placeholder="Suggested agent (optional)"
        value={suggested}
        onChange={(e) => setSuggested(e.target.value)}
        className="w-full rounded border border-[var(--border)] bg-white px-2 py-1 text-xs outline-none"
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-[var(--muted-foreground)] hover:underline"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isPending || !title.trim()}
          className="rounded bg-[var(--primary)] px-2 py-1 text-xs font-medium text-[var(--primary-foreground)] disabled:opacity-50"
        >
          {isPending ? 'Creating…' : 'Create'}
        </button>
      </div>
    </form>
  );
}
