'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { addPortalUpdateAction } from '@/server/actions/portal-updates';

export function PortalUpdateForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [type, setType] = useState<'progress' | 'photo' | 'milestone' | 'message'>('progress');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  async function handleSubmit() {
    setLoading(true);
    setError(null);
    const result = await addPortalUpdateAction({
      projectId,
      type,
      title,
      body: body || undefined,
    });
    if (!result.ok) {
      setError(result.error);
      setLoading(false);
      return;
    }
    setTitle('');
    setBody('');
    setOpen(false);
    setLoading(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted/50"
      >
        Post Update
      </button>
    );
  }

  return (
    <div className="rounded-lg border p-4 space-y-3">
      {error ? <div className="rounded-md bg-red-50 p-2 text-xs text-red-700">{error}</div> : null}

      <div className="flex gap-2">
        {(['progress', 'photo', 'milestone', 'message'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setType(t)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              type === t
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        placeholder="Update title"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        placeholder="Details (optional)"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={loading}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? 'Posting...' : 'Post'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted/50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
