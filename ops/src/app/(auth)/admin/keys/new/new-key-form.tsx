'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { createKeyAction } from '../actions';

const ALL_SCOPES = [
  'read:worklog',
  'write:worklog',
  'admin:worklog',
  'read:roadmap',
  'write:roadmap',
  'admin:roadmap',
  'read:ideas',
  'write:ideas',
  'read:decisions',
  'write:decisions',
  'read:knowledge',
  'write:knowledge',
  'read:competitors',
  'write:competitors',
  'read:incidents',
  'write:incidents',
  'read:social',
  'write:social',
  'read:docs',
  'write:docs',
  'read:review_queue',
  'write:escalate',
  'read:kanban',
  'write:kanban',
  'admin:maintenance',
];

export function NewKeyForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [days, setDays] = useState(90);
  const [scopes, setScopes] = useState<string[]>(['read:worklog', 'write:worklog']);
  const [reveal, setReveal] = useState<{ key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [isPending, startTransition] = useTransition();

  function toggleScope(s: string) {
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await createKeyAction({ name: name.trim(), days, scopes });
      if (res.ok) {
        setReveal({ key: res.rawKey });
      } else {
        toast.error(res.error);
      }
    });
  }

  if (reveal) {
    return (
      <div className="space-y-4 rounded-md border border-amber-400 bg-amber-50 p-4">
        <h2 className="text-sm font-semibold">Copy this now — it won't be shown again</h2>
        <pre className="overflow-x-auto rounded-md border border-amber-200 bg-white p-3 text-xs">
          {reveal.key}
        </pre>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(reveal.key);
              setCopied(true);
            }}
            className="rounded-md bg-[var(--primary)] px-3 py-2 text-sm font-medium text-[var(--primary-foreground)]"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            disabled={!copied}
            onClick={() => router.push('/admin/keys')}
            className="text-sm text-[var(--muted-foreground)] hover:underline disabled:opacity-40"
          >
            I've saved it — close
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label className="text-xs font-medium text-[var(--muted-foreground)]">
          Name
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Paperclip: content writer"
            className="mt-1 w-full rounded-md border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
          />
        </label>
      </div>

      <div>
        <label className="text-xs font-medium text-[var(--muted-foreground)]">
          Expires in (days)
          <input
            type="number"
            min={1}
            max={365}
            required
            value={days}
            onChange={(e) => setDays(Math.max(1, Math.min(365, Number(e.target.value))))}
            className="mt-1 w-32 rounded-md border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
          />
        </label>
      </div>

      <fieldset>
        <legend className="mb-2 text-xs font-medium text-[var(--muted-foreground)]">Scopes</legend>
        <div className="grid grid-cols-2 gap-2">
          {ALL_SCOPES.map((s) => (
            <label key={s} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggleScope(s)} />
              <code className="text-xs">{s}</code>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={isPending || !name.trim() || scopes.length === 0}
          className="rounded-md bg-[var(--primary)] px-3 py-2 text-sm font-medium text-[var(--primary-foreground)] disabled:opacity-50"
        >
          {isPending ? 'Creating…' : 'Create key'}
        </button>
      </div>
    </form>
  );
}
