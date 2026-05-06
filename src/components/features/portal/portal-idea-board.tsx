'use client';

/**
 * Customer-facing idea board on the public portal.
 *
 * Three composer affordances — Image / Link / Note — write to one
 * discriminated table. Cards render in a grid ordered by created_at desc.
 * Optional per-room tagging and a room filter chip row above the grid
 * when at least one tagged item exists.
 *
 * NO external notifications fire when the customer adds an item — the
 * operator gets a passive in-app badge on the Selections tab. This is a
 * deliberate choice from CUSTOMER_IDEA_BOARD_PLAN.md to give the customer
 * permission to dump everything without pummeling the contractor.
 */

import { ImagePlus, Link as LinkIcon, Loader2, StickyNote, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { resizeImage } from '@/lib/storage/resize-image';
import { cn } from '@/lib/utils';
import {
  addCustomerIdeaBoardImageAction,
  addCustomerIdeaBoardLinkAction,
  addCustomerIdeaBoardNoteAction,
  deleteCustomerIdeaBoardItemAction,
  fetchIdeaBoardUrlPreviewAction,
  getCustomerIdeaBoardItemsAction,
  type IdeaBoardItem,
} from '@/server/actions/project-idea-board';

const POLL_INTERVAL_MS = 5_000;
type ComposerMode = 'image' | 'link' | 'note';

export function PortalIdeaBoard({
  portalSlug,
  initialItems,
  roomSuggestions,
}: {
  portalSlug: string;
  initialItems: IdeaBoardItem[];
  roomSuggestions: string[];
}) {
  const [items, setItems] = useState<IdeaBoardItem[]>(initialItems);
  const [composerMode, setComposerMode] = useState<ComposerMode>('image');
  const [roomFilter, setRoomFilter] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await getCustomerIdeaBoardItemsAction(portalSlug);
    if (res.ok) {
      setItems((prev) => {
        if (prev.length === res.items.length) {
          const lastPrev = prev[0]?.id;
          const lastNext = res.items[0]?.id;
          if (lastPrev === lastNext) return prev;
        }
        return res.items;
      });
    }
  }, [portalSlug]);

  useEffect(() => {
    const interval = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  const distinctRooms = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) {
      if (item.room) set.add(item.room);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [items]);

  const filteredItems = useMemo(() => {
    if (roomFilter === null) return items;
    if (roomFilter === '') return items.filter((i) => !i.room);
    return items.filter((i) => i.room === roomFilter);
  }, [items, roomFilter]);

  const onAdded = useCallback(() => {
    void refresh();
  }, [refresh]);

  return (
    <section aria-labelledby="idea-board-heading" className="space-y-4">
      <div>
        <h2 id="idea-board-heading" className="text-base font-semibold">
          Idea board
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Drop images, paste Pinterest or vendor links, or jot a note. Just for you and your
          contractor — no notifications fire when you add something. Add as much as you want.
        </p>
      </div>

      <div className="rounded-lg border bg-card p-3">
        <ComposerModeTabs mode={composerMode} onChange={setComposerMode} />
        <div className="mt-3">
          {composerMode === 'image' ? (
            <ImageComposer
              portalSlug={portalSlug}
              roomSuggestions={roomSuggestions}
              onAdded={onAdded}
            />
          ) : null}
          {composerMode === 'link' ? (
            <LinkComposer
              portalSlug={portalSlug}
              roomSuggestions={roomSuggestions}
              onAdded={onAdded}
            />
          ) : null}
          {composerMode === 'note' ? (
            <NoteComposer
              portalSlug={portalSlug}
              roomSuggestions={roomSuggestions}
              onAdded={onAdded}
            />
          ) : null}
        </div>
      </div>

      {distinctRooms.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <RoomChip label="All" active={roomFilter === null} onClick={() => setRoomFilter(null)} />
          {distinctRooms.map((room) => (
            <RoomChip
              key={room}
              label={room}
              active={roomFilter === room}
              onClick={() => setRoomFilter(room)}
            />
          ))}
          {items.some((i) => !i.room) ? (
            <RoomChip
              label="Unsorted"
              active={roomFilter === ''}
              onClick={() => setRoomFilter('')}
            />
          ) : null}
        </div>
      ) : null}

      {filteredItems.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-muted/30 px-4 py-10 text-center">
          <ImagePlus className="mx-auto size-6 text-muted-foreground" aria-hidden />
          <p className="mt-2 text-sm font-medium">Nothing here yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Add an image, link, or note above to get started.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {filteredItems.map((item) => (
            <IdeaCard key={item.id} item={item} portalSlug={portalSlug} onDeleted={onAdded} />
          ))}
        </div>
      )}
    </section>
  );
}

function ComposerModeTabs({
  mode,
  onChange,
}: {
  mode: ComposerMode;
  onChange: (m: ComposerMode) => void;
}) {
  const tabs: Array<{ key: ComposerMode; label: string; Icon: typeof ImagePlus }> = [
    { key: 'image', label: 'Image', Icon: ImagePlus },
    { key: 'link', label: 'Link', Icon: LinkIcon },
    { key: 'note', label: 'Note', Icon: StickyNote },
  ];
  return (
    <div className="flex gap-1 rounded-md bg-muted p-1 text-xs">
      {tabs.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          className={cn(
            'inline-flex flex-1 items-center justify-center gap-1.5 rounded px-3 py-1.5 font-medium transition-colors',
            mode === key
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="size-3.5" aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );
}

function RoomInput({
  value,
  onChange,
  suggestions,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
  disabled?: boolean;
}) {
  const listId = useMemo(() => `room-suggestions-${Math.random().toString(36).slice(2, 8)}`, []);
  return (
    <div>
      <label className="block text-xs font-medium text-muted-foreground" htmlFor={listId}>
        Room (optional)
      </label>
      <Input
        id={listId}
        list={`${listId}-list`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. Kitchen, Master Bath"
        maxLength={80}
        disabled={disabled}
        className="mt-1 h-9 text-sm"
      />
      <datalist id={`${listId}-list`}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}

function ImageComposer({
  portalSlug,
  roomSuggestions,
  onAdded,
}: {
  portalSlug: string;
  roomSuggestions: string[];
  onAdded: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [staged, setStaged] = useState<{ file: File; previewUrl: string } | null>(null);
  const [room, setRoom] = useState('');
  const [notes, setNotes] = useState('');
  const [pending, startTransition] = useTransition();
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  function pickFile(file: File | null | undefined) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Only image files are supported.');
      return;
    }
    if (staged) URL.revokeObjectURL(staged.previewUrl);
    setStaged({ file, previewUrl: URL.createObjectURL(file) });
  }

  function clearStaged() {
    if (staged) URL.revokeObjectURL(staged.previewUrl);
    setStaged(null);
  }

  function handleSave() {
    if (!staged) return;
    startTransition(async () => {
      try {
        const resized = await resizeImage(staged.file, { maxDimension: 1280, quality: 0.8 });
        const finalFile =
          resized instanceof File
            ? resized
            : new File([resized], staged.file.name || 'idea.jpg', { type: 'image/jpeg' });
        const fd = new FormData();
        fd.append('portal_slug', portalSlug);
        fd.append('file', finalFile);
        if (room.trim()) fd.append('room', room.trim());
        if (notes.trim()) fd.append('notes', notes.trim());
        const res = await addCustomerIdeaBoardImageAction(fd);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success('Image added.');
        clearStaged();
        setRoom('');
        setNotes('');
        onAdded();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed.';
        toast.error(msg);
      }
    });
  }

  return (
    <div className="space-y-3">
      {!staged ? (
        <label
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors',
            isDraggingOver
              ? 'border-primary bg-primary/5'
              : 'border-muted-foreground/30 hover:border-muted-foreground/60',
          )}
          onDrop={(e) => {
            e.preventDefault();
            setIsDraggingOver(false);
            pickFile(e.dataTransfer?.files?.[0]);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDraggingOver(true);
          }}
          onDragLeave={() => setIsDraggingOver(false)}
        >
          <ImagePlus className="size-6 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">Tap to choose, or drag here</p>
          <p className="text-xs text-muted-foreground">JPG, PNG, WebP, or GIF — up to 10MB</p>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => pickFile(e.target.files?.[0])}
          />
        </label>
      ) : (
        <div className="flex items-start gap-3 rounded-md border bg-background p-3">
          <div className="size-20 shrink-0 overflow-hidden rounded border bg-muted">
            {/* biome-ignore lint/performance/noImgElement: blob URL preview */}
            <img src={staged.previewUrl} alt="" className="size-full object-cover" aria-hidden />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm">{staged.file.name}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={clearStaged}
                aria-label="Remove"
              >
                <X className="size-4" />
              </Button>
            </div>
            <RoomInput
              value={room}
              onChange={setRoom}
              suggestions={roomSuggestions}
              disabled={pending}
            />
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What do you like about this? (optional)"
              maxLength={4000}
              disabled={pending}
              rows={2}
              className="resize-none text-sm"
            />
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <Button type="button" disabled={!staged || pending} onClick={handleSave}>
          {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          {pending ? 'Saving…' : 'Add to board'}
        </Button>
      </div>
    </div>
  );
}

function LinkComposer({
  portalSlug,
  roomSuggestions,
  onAdded,
}: {
  portalSlug: string;
  roomSuggestions: string[];
  onAdded: () => void;
}) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [room, setRoom] = useState('');
  const [notes, setNotes] = useState('');
  const [pending, startTransition] = useTransition();
  const userEditedTitleRef = useRef(false);

  // Debounced preview fetch
  useEffect(() => {
    const trimmed = url.trim();
    if (!trimmed || !/^https?:\/\//i.test(trimmed)) {
      setThumbnailUrl(null);
      if (!trimmed) {
        setTitle('');
        userEditedTitleRef.current = false;
      }
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    const t = setTimeout(async () => {
      const res = await fetchIdeaBoardUrlPreviewAction({ portalSlug, url: trimmed });
      if (cancelled) return;
      setPreviewLoading(false);
      if (res.ok) {
        if (res.preview.thumbnail_url) setThumbnailUrl(res.preview.thumbnail_url);
        if (res.preview.title && !userEditedTitleRef.current) setTitle(res.preview.title);
      } else {
        setThumbnailUrl(null);
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [url, portalSlug]);

  function handleSave() {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      toast.error('Paste a URL first.');
      return;
    }
    startTransition(async () => {
      const res = await addCustomerIdeaBoardLinkAction({
        portalSlug,
        url: trimmedUrl,
        title: title.trim() || undefined,
        thumbnailUrl,
        notes: notes.trim() || undefined,
        room: room.trim() || undefined,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Link added.');
      setUrl('');
      setTitle('');
      setThumbnailUrl(null);
      setRoom('');
      setNotes('');
      onAdded();
    });
  }

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="idea-link-url" className="block text-xs font-medium text-muted-foreground">
          URL
        </label>
        <Input
          id="idea-link-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.pinterest.com/pin/..."
          maxLength={2048}
          disabled={pending}
          className="mt-1 h-9 text-sm"
        />
      </div>

      {previewLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Fetching preview…
        </div>
      ) : thumbnailUrl ? (
        <div className="flex items-start gap-3 rounded-md border bg-background p-2">
          {/* biome-ignore lint/performance/noImgElement: external thumbnail */}
          <img
            src={thumbnailUrl}
            alt=""
            className="size-20 shrink-0 rounded object-cover"
            referrerPolicy="no-referrer"
          />
          <div className="min-w-0 flex-1 space-y-1">
            <Input
              value={title}
              onChange={(e) => {
                userEditedTitleRef.current = true;
                setTitle(e.target.value);
              }}
              placeholder="Title"
              maxLength={280}
              disabled={pending}
              className="h-8 text-sm"
            />
            <p className="truncate text-xs text-muted-foreground">{safeHostname(url)}</p>
          </div>
        </div>
      ) : null}

      <RoomInput value={room} onChange={setRoom} suggestions={roomSuggestions} disabled={pending} />

      <Textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="What do you like about this? (optional)"
        maxLength={4000}
        disabled={pending}
        rows={2}
        className="resize-none text-sm"
      />

      <div className="flex justify-end">
        <Button type="button" disabled={!url.trim() || pending} onClick={handleSave}>
          {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          {pending ? 'Saving…' : 'Add to board'}
        </Button>
      </div>
    </div>
  );
}

function NoteComposer({
  portalSlug,
  roomSuggestions,
  onAdded,
}: {
  portalSlug: string;
  roomSuggestions: string[];
  onAdded: () => void;
}) {
  const [notes, setNotes] = useState('');
  const [room, setRoom] = useState('');
  const [pending, startTransition] = useTransition();

  function handleSave() {
    const trimmed = notes.trim();
    if (!trimmed) return;
    startTransition(async () => {
      const res = await addCustomerIdeaBoardNoteAction({
        portalSlug,
        notes: trimmed,
        room: room.trim() || undefined,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Note added.');
      setNotes('');
      setRoom('');
      onAdded();
    });
  }

  return (
    <div className="space-y-3">
      <Textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Thinking warm wood floors here…"
        maxLength={4000}
        disabled={pending}
        rows={4}
        className="resize-none text-sm"
      />
      <RoomInput value={room} onChange={setRoom} suggestions={roomSuggestions} disabled={pending} />
      <div className="flex justify-end">
        <Button type="button" disabled={!notes.trim() || pending} onClick={handleSave}>
          {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          {pending ? 'Saving…' : 'Add to board'}
        </Button>
      </div>
    </div>
  );
}

function RoomChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-1 font-medium transition-colors',
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-muted bg-card text-muted-foreground hover:bg-muted/50',
      )}
    >
      {label}
    </button>
  );
}

function IdeaCard({
  item,
  portalSlug,
  onDeleted,
}: {
  item: IdeaBoardItem;
  portalSlug: string;
  onDeleted: () => void;
}) {
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    if (!window.confirm('Remove this idea from your board?')) return;
    startTransition(async () => {
      const res = await deleteCustomerIdeaBoardItemAction({ portalSlug, itemId: item.id });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      onDeleted();
    });
  }

  const promoted = Boolean(item.promoted_to_selection_id);

  return (
    <article className="relative flex flex-col overflow-hidden rounded-lg border bg-card">
      {item.kind === 'image' && item.image_url ? (
        // biome-ignore lint/performance/noImgElement: signed URL
        <img
          src={item.image_url}
          alt={item.title ?? ''}
          className="aspect-square w-full object-cover"
          loading="lazy"
        />
      ) : null}

      {item.kind === 'link' ? (
        <a
          href={item.source_url ?? '#'}
          target="_blank"
          rel="noopener noreferrer"
          className="block"
        >
          {item.thumbnail_url ? (
            // biome-ignore lint/performance/noImgElement: external thumbnail
            <img
              src={item.thumbnail_url}
              alt={item.title ?? ''}
              className="aspect-video w-full bg-muted object-cover"
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="flex aspect-video w-full items-center justify-center bg-muted">
              <LinkIcon className="size-6 text-muted-foreground" aria-hidden />
            </div>
          )}
        </a>
      ) : null}

      <div className="flex-1 space-y-1.5 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {item.kind === 'link' && item.source_url ? (
              <a
                href={item.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="truncate text-sm font-medium hover:underline"
              >
                {item.title || safeHostname(item.source_url)}
              </a>
            ) : item.title ? (
              <p className="truncate text-sm font-medium">{item.title}</p>
            ) : null}
            {item.kind === 'link' && item.source_url ? (
              <p className="truncate text-xs text-muted-foreground">
                {safeHostname(item.source_url)}
              </p>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleDelete}
            disabled={pending}
            className="-mr-1 -mt-1 size-7 shrink-0 text-muted-foreground hover:text-destructive"
            aria-label="Delete"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>

        {item.notes ? (
          <p className="whitespace-pre-wrap text-xs text-muted-foreground">{item.notes}</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {item.room ? (
            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">
              {item.room}
            </span>
          ) : null}
          {promoted ? (
            <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
              Promoted to selection
            </span>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function safeHostname(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return raw;
  }
}
