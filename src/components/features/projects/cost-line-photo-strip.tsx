'use client';

import { useRef, useState, useTransition } from 'react';
import {
  attachCostLinePhotoAction,
  removeCostLinePhotoAction,
} from '@/server/actions/project-cost-control';

export function CostLinePhotoStrip({
  costLineId,
  projectId,
  photos,
}: {
  costLineId: string;
  projectId: string;
  photos: { path: string; url: string }[];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    const fd = new FormData();
    fd.set('cost_line_id', costLineId);
    fd.set('project_id', projectId);
    fd.set('photo', file);
    startTransition(async () => {
      const res = await attachCostLinePhotoAction(fd);
      if (!res.ok) setError(res.error);
      if (inputRef.current) inputRef.current.value = '';
    });
  }

  function onDelete(path: string) {
    if (!confirm('Remove this photo?')) return;
    startTransition(async () => {
      const res = await removeCostLinePhotoAction({ costLineId, projectId, storagePath: path });
      if (!res.ok) setError(res.error);
    });
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      {photos.map((p) => (
        <a
          key={p.path}
          href={p.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group relative block h-14 w-14 overflow-hidden rounded-md border"
        >
          {/* biome-ignore lint/performance/noImgElement: signed URLs bypass next/image optimizer */}
          <img src={p.url} alt="" className="h-full w-full object-cover" />
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              onDelete(p.path);
            }}
            className="absolute right-0.5 top-0.5 hidden rounded-full bg-black/70 px-1.5 text-[10px] text-white group-hover:block"
          >
            ×
          </button>
        </a>
      ))}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={pending}
        className="flex h-14 w-14 items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-50"
      >
        {pending ? '…' : '+ Photo'}
      </button>
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={onPick} />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
