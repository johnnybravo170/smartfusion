'use client';

/**
 * The interactive team-checklist surface. Mobile-first.
 *
 * Layout per row: big tap-target checkbox + title + category chip +
 * photo thumb (or "+ photo" button) + kebab menu (rename / delete).
 * Add row at the top: title input + category chip + Add button.
 *
 * State strategy: optimistic updates against the server actions, with a
 * `pending` set so a row can show a subtle muted state while the action is
 * in flight. Failures roll back and surface a toast.
 */

import { Camera, Check, ListChecks, Loader2, MoreVertical, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useId, useOptimistic, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { ChecklistItemRow } from '@/lib/db/queries/project-checklist';
import { cn } from '@/lib/utils';
import {
  addChecklistItemAction,
  attachChecklistPhotoAction,
  deleteChecklistItemAction,
  removeChecklistPhotoAction,
  toggleChecklistItemAction,
  updateChecklistItemTitleAction,
} from '@/server/actions/project-checklist';

type Item = ChecklistItemRow & { photo_url: string | null };

type OptimisticOp =
  | { kind: 'add'; item: Item }
  | { kind: 'remove'; id: string }
  | { kind: 'update'; id: string; patch: Partial<Item> };

function applyOp(items: Item[], op: OptimisticOp): Item[] {
  switch (op.kind) {
    case 'add':
      return [op.item, ...items];
    case 'remove':
      return items.filter((i) => i.id !== op.id);
    case 'update':
      return items.map((i) => (i.id === op.id ? { ...i, ...op.patch } : i));
  }
}

export function TeamChecklistClient({
  projectId,
  projectName,
  chrome,
  initialItems,
  knownCategories,
}: {
  projectId: string;
  projectName?: string;
  /** `card` wraps the surface in its own titled Card. `bare` renders just
   * the add-row + list, for embedding inside an existing Card on the host
   * page (e.g. the worker dashboard, where the host already shows a title
   * + site switcher). */
  chrome: 'card' | 'bare';
  initialItems: Item[];
  knownCategories: string[];
}) {
  const [items, applyOptimistic] = useOptimistic<Item[], OptimisticOp>(initialItems, applyOp);

  const open = items.filter((i) => !i.completed_at);
  const completed = items.filter((i) => i.completed_at);

  const inner = (
    <>
      <AddRow
        projectId={projectId}
        knownCategories={knownCategories}
        onAdd={(item) => applyOptimistic({ kind: 'add', item })}
      />

      {open.length === 0 && completed.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="flex flex-col">
          {open.map((item) => (
            <ItemRow key={item.id} item={item} applyOptimistic={applyOptimistic} />
          ))}
          {completed.length > 0 && open.length > 0 ? (
            <li className="my-1 border-t" aria-hidden />
          ) : null}
          {completed.map((item) => (
            <ItemRow key={item.id} item={item} applyOptimistic={applyOptimistic} />
          ))}
        </ul>
      )}
    </>
  );

  if (chrome === 'bare') {
    return <div className="flex flex-col gap-2">{inner}</div>;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-baseline justify-between gap-2">
          <CardTitle className="text-base">Team checklist</CardTitle>
          {projectName ? (
            <span className="truncate text-xs text-muted-foreground">{projectName}</span>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 pt-0">{inner}</CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-6 text-center">
      <ListChecks className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">Nothing on the list yet</p>
      <p className="text-xs text-muted-foreground">
        Add what the team needs &mdash; materials, calls, follow-ups.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add row
// ---------------------------------------------------------------------------

function AddRow({
  projectId,
  knownCategories,
  onAdd,
}: {
  projectId: string;
  knownCategories: string[];
  onAdd: (item: Item) => void;
}) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    const trimmed = title.trim();
    if (!trimmed) return;
    const tempId = `temp-${crypto.randomUUID()}`;
    const optimistic: Item = {
      id: tempId,
      tenant_id: '',
      project_id: projectId,
      title: trimmed,
      category,
      photo_storage_path: null,
      photo_mime: null,
      created_by: null,
      completed_at: null,
      completed_by: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      photo_url: null,
    };

    startTransition(async () => {
      onAdd(optimistic);
      setTitle('');
      const res = await addChecklistItemAction({
        projectId,
        title: trimmed,
        category: category ?? undefined,
      });
      if (!res.ok) toast.error(res.error);
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Add a thing&hellip;"
        className="flex-1"
        disabled={pending}
        aria-label="New checklist item"
      />
      <CategoryPicker value={category} onChange={setCategory} knownCategories={knownCategories} />
      <Button size="sm" onClick={submit} disabled={pending || !title.trim()}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
        <span className="sr-only">Add</span>
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Category picker (used by add row + item row)
// ---------------------------------------------------------------------------

function CategoryPicker({
  value,
  onChange,
  knownCategories,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  knownCategories: string[];
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');

  function pick(next: string | null) {
    onChange(next);
    setOpen(false);
    setDraft('');
  }

  function commitDraft() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    pick(trimmed);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex h-9 items-center gap-1 rounded-md border px-2 text-xs shrink-0',
            value
              ? 'border-foreground/20 bg-muted text-foreground'
              : 'border-dashed text-muted-foreground hover:bg-muted',
          )}
          aria-label={value ? `Category: ${value}` : 'Pick category'}
        >
          {value ?? 'Tag'}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-2" align="end">
        <div className="flex flex-col gap-1">
          {knownCategories.length > 0 && (
            <>
              <p className="px-2 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Used here
              </p>
              {knownCategories.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => pick(c)}
                  className={cn(
                    'flex items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted',
                    c === value && 'bg-muted font-medium',
                  )}
                >
                  {c}
                  {c === value ? <Check className="size-3.5" /> : null}
                </button>
              ))}
              <div className="my-1 border-t" />
            </>
          )}
          <div className="flex items-center gap-1 px-1">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitDraft();
                }
              }}
              placeholder="New category&hellip;"
              className="h-8 text-sm"
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={commitDraft}
              disabled={!draft.trim()}
              className="h-8 px-2"
            >
              Add
            </Button>
          </div>
          {value !== null && (
            <button
              type="button"
              onClick={() => pick(null)}
              className="mt-1 px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground rounded-sm"
            >
              Clear category
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Item row
// ---------------------------------------------------------------------------

function ItemRow({
  item,
  applyOptimistic,
}: {
  item: Item;
  applyOptimistic: (op: OptimisticOp) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const isCompleted = !!item.completed_at;

  function toggle() {
    const nextCompletedAt = isCompleted ? null : new Date().toISOString();
    startTransition(async () => {
      applyOptimistic({
        kind: 'update',
        id: item.id,
        patch: { completed_at: nextCompletedAt },
      });
      const res = await toggleChecklistItemAction({ itemId: item.id });
      if (!res.ok) toast.error(res.error);
    });
  }

  function remove() {
    startTransition(async () => {
      applyOptimistic({ kind: 'remove', id: item.id });
      const res = await deleteChecklistItemAction({ itemId: item.id });
      if (!res.ok) toast.error(res.error);
    });
  }

  return (
    <li
      className={cn(
        'flex items-start gap-2 py-2 border-b last:border-0 transition-opacity',
        pending && 'opacity-60',
      )}
    >
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        aria-label={isCompleted ? 'Mark not done' : 'Mark done'}
        className={cn(
          'mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md border transition',
          isCompleted
            ? 'border-foreground/40 bg-foreground text-background'
            : 'border-foreground/30 hover:bg-muted',
        )}
      >
        {isCompleted ? <Check className="size-4" /> : null}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {editing ? (
          <InlineTitleEditor
            initial={item.title}
            onCancel={() => setEditing(false)}
            onSave={(next) => {
              if (next === item.title) {
                setEditing(false);
                return;
              }
              startTransition(async () => {
                applyOptimistic({ kind: 'update', id: item.id, patch: { title: next } });
                setEditing(false);
                const res = await updateChecklistItemTitleAction({
                  itemId: item.id,
                  title: next,
                });
                if (!res.ok) toast.error(res.error);
              });
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={cn(
              'text-left text-sm leading-snug',
              isCompleted && 'text-muted-foreground line-through',
            )}
          >
            {item.title}
          </button>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          {item.category ? (
            <span className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {item.category}
            </span>
          ) : null}

          <PhotoControl item={item} applyOptimistic={applyOptimistic} />
        </div>
      </div>

      <RowMenu onDelete={remove} pending={pending} />
    </li>
  );
}

function InlineTitleEditor({
  initial,
  onCancel,
  onSave,
}: {
  initial: string;
  onCancel: () => void;
  onSave: (next: string) => void;
}) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  function commit() {
    const trimmed = v.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    onSave(trimmed);
  }

  return (
    <Input
      ref={ref}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={commit}
      className="h-7 text-sm"
    />
  );
}

// ---------------------------------------------------------------------------
// Photo control: thumbnail (with remove) or "+ photo" button
// ---------------------------------------------------------------------------

function PhotoControl({
  item,
  applyOptimistic,
}: {
  item: Item;
  applyOptimistic: (op: OptimisticOp) => void;
}) {
  const inputId = useId();
  const [pending, startTransition] = useTransition();

  function handleFile(file: File) {
    if (!file) return;
    const localUrl = URL.createObjectURL(file);
    startTransition(async () => {
      applyOptimistic({
        kind: 'update',
        id: item.id,
        patch: { photo_url: localUrl, photo_mime: file.type },
      });
      const fd = new FormData();
      fd.append('itemId', item.id);
      fd.append('file', file);
      const res = await attachChecklistPhotoAction(fd);
      if (!res.ok) {
        toast.error(res.error);
        applyOptimistic({
          kind: 'update',
          id: item.id,
          patch: { photo_url: null, photo_mime: null },
        });
      }
    });
  }

  function clearPhoto() {
    startTransition(async () => {
      applyOptimistic({
        kind: 'update',
        id: item.id,
        patch: { photo_url: null, photo_storage_path: null, photo_mime: null },
      });
      const res = await removeChecklistPhotoAction({ itemId: item.id });
      if (!res.ok) toast.error(res.error);
    });
  }

  if (item.photo_url) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="relative inline-block size-9 overflow-hidden rounded-md border"
            aria-label="View photo"
          >
            {/* biome-ignore lint/performance/noImgElement: signed URL, not a static asset */}
            <img src={item.photo_url} alt="" className="size-full object-cover" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-2">
          {/* biome-ignore lint/performance/noImgElement: signed URL */}
          <img src={item.photo_url} alt="" className="w-full rounded-sm object-contain" />
          <Button
            size="sm"
            variant="ghost"
            onClick={clearPhoto}
            disabled={pending}
            className="mt-2 w-full text-destructive hover:text-destructive"
          >
            <X className="size-4" /> Remove photo
          </Button>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <>
      <input
        id={inputId}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        disabled={pending}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
          e.currentTarget.value = '';
        }}
      />
      <label
        htmlFor={inputId}
        className={cn(
          'inline-flex h-5 cursor-pointer items-center gap-1 rounded-full border border-dashed px-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:bg-muted',
          pending && 'pointer-events-none opacity-60',
        )}
      >
        {pending ? <Loader2 className="size-3 animate-spin" /> : <Camera className="size-3" />}
        Photo
      </label>
    </>
  );
}

function RowMenu({ onDelete, pending }: { onDelete: () => void; pending: boolean }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted"
          aria-label="More"
          disabled={pending}
        >
          <MoreVertical className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="end">
        <button
          type="button"
          onClick={onDelete}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="size-4" />
          Delete
        </button>
      </PopoverContent>
    </Popover>
  );
}
