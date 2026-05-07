'use client';

/**
 * Customer-facing Selections panel on the public portal.
 *
 * Two surfaces in one component:
 *   1. A lightweight composer for customer-authored selections — room
 *      (required, autocomplete), category, name, color code, notes,
 *      single optional image. Skips operator-grade fields (brand,
 *      finish, supplier, sku, allowance, etc).
 *   2. The list of all selections grouped by room, with operator and
 *      customer rows rendered side by side. Customer-authored rows
 *      carry a small chip and a delete affordance; operator rows are
 *      read-only here (the operator edits from /projects/[id]).
 *
 * Customer rows store a single inline image at
 * project_selections.image_storage_path; operator rows reference photos
 * via photo_refs. The renderer handles both.
 */

import { ImagePlus, Loader2, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { ProjectSelection } from '@/lib/db/queries/project-selections';
import { resizeImage } from '@/lib/storage/resize-image';
import { cn } from '@/lib/utils';
import {
  SELECTION_CATEGORIES,
  type SelectionCategory,
  selectionCategoryLabels,
} from '@/lib/validators/project-selection';
import {
  addCustomerSelectionAction,
  deleteCustomerSelectionAction,
} from '@/server/actions/project-selections';

type PortalSelection = ProjectSelection & {
  /** Resolved server-side: signed URL for image_storage_path or photo_refs[0]. */
  image_url?: string | null;
};

export function PortalSelectionsPanel({
  portalSlug,
  initialSelections,
  roomSuggestions,
}: {
  portalSlug: string;
  initialSelections: PortalSelection[];
  roomSuggestions: string[];
}) {
  const router = useRouter();

  const refresh = useCallback(() => {
    router.refresh();
  }, [router]);

  const groups = useMemo(() => groupByRoom(initialSelections), [initialSelections]);

  return (
    <section aria-labelledby="selections-heading" className="space-y-4">
      <div>
        <h2 id="selections-heading" className="text-base font-semibold">
          Selections
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Record what you&rsquo;ve actually chosen — paint chips, tile, fixture model numbers.
          Survives into your final Home Record.
        </p>
      </div>

      <SelectionComposer
        portalSlug={portalSlug}
        roomSuggestions={roomSuggestions}
        onSaved={refresh}
      />

      {groups.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-muted/30 px-4 py-10 text-center">
          <p className="text-sm font-medium">No selections yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Add your first one above. Your contractor will see it on their end.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.room} className="rounded-lg border bg-card">
              <h3 className="border-b px-4 py-2 text-sm font-semibold">{group.room}</h3>
              <ul className="divide-y">
                {group.items.map((sel) => (
                  <SelectionRow
                    key={sel.id}
                    portalSlug={portalSlug}
                    selection={sel}
                    onDeleted={refresh}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function groupByRoom(items: PortalSelection[]): Array<{ room: string; items: PortalSelection[] }> {
  const map = new Map<string, PortalSelection[]>();
  for (const sel of items) {
    const key = sel.room?.trim() || 'Unsorted';
    const list = map.get(key) ?? [];
    list.push(sel);
    map.set(key, list);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([room, items]) => ({ room, items }));
}

function SelectionComposer({
  portalSlug,
  roomSuggestions,
  onSaved,
}: {
  portalSlug: string;
  roomSuggestions: string[];
  onSaved: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [room, setRoom] = useState('');
  const [category, setCategory] = useState<SelectionCategory>('paint');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [notes, setNotes] = useState('');
  const [staged, setStaged] = useState<{ file: File; previewUrl: string } | null>(null);
  const [pending, startTransition] = useTransition();

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
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function reset() {
    setRoom('');
    setCategory('paint');
    setName('');
    setCode('');
    setNotes('');
    clearStaged();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedRoom = room.trim();
    if (!trimmedRoom) {
      toast.error('Room is required.');
      return;
    }
    startTransition(async () => {
      const fd = new FormData();
      fd.append('portal_slug', portalSlug);
      fd.append('room', trimmedRoom);
      fd.append('category', category);
      if (name.trim()) fd.append('name', name.trim());
      if (code.trim()) fd.append('code', code.trim());
      if (notes.trim()) fd.append('notes', notes.trim());
      if (staged) {
        try {
          const resized = await resizeImage(staged.file, { maxDimension: 1280, quality: 0.8 });
          const finalFile =
            resized instanceof File
              ? resized
              : new File([resized], staged.file.name || 'selection.jpg', { type: 'image/jpeg' });
          fd.append('file', finalFile);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Image processing failed.';
          toast.error(msg);
          return;
        }
      }
      const res = await addCustomerSelectionAction(fd);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Selection added.');
      reset();
      onSaved();
    });
  }

  const roomListId = useMemo(
    () => `room-suggest-sel-${Math.random().toString(36).slice(2, 8)}`,
    [],
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border bg-card p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor={roomListId}>Room</Label>
          <Input
            id={roomListId}
            list={`${roomListId}-list`}
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            placeholder="e.g. Master bathroom"
            maxLength={80}
            disabled={pending}
            required
            className="mt-1 h-9 text-sm"
          />
          <datalist id={`${roomListId}-list`}>
            {roomSuggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
        <div>
          <Label htmlFor="cust-sel-category">Category</Label>
          <select
            id="cust-sel-category"
            value={category}
            onChange={(e) => setCategory(e.target.value as SelectionCategory)}
            disabled={pending}
            className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
          >
            {SELECTION_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {selectionCategoryLabels[c]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="cust-sel-name">Name</Label>
          <Input
            id="cust-sel-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Hale Navy"
            maxLength={280}
            disabled={pending}
            className="mt-1 h-9 text-sm"
          />
        </div>
        <div>
          <Label htmlFor="cust-sel-code">Color / code</Label>
          <Input
            id="cust-sel-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="HC-154"
            maxLength={80}
            disabled={pending}
            className="mt-1 h-9 text-sm"
          />
        </div>
      </div>
      <div>
        <Label htmlFor="cust-sel-notes">Notes</Label>
        <Textarea
          id="cust-sel-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional details — finish, where you saw it, why you liked it"
          maxLength={4000}
          disabled={pending}
          rows={2}
          className="mt-1 resize-none text-sm"
        />
      </div>
      <div>
        <Label className="block">Photo (optional)</Label>
        {!staged ? (
          <label
            className={cn(
              'mt-1 flex cursor-pointer items-center justify-center gap-2 rounded-md border-2 border-dashed border-muted-foreground/30 px-3 py-3 text-xs text-muted-foreground transition-colors hover:border-muted-foreground/60',
              pending && 'pointer-events-none opacity-60',
            )}
          >
            <ImagePlus className="size-4" aria-hidden />
            Tap to choose, or drag in a photo
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => pickFile(e.target.files?.[0])}
              disabled={pending}
            />
          </label>
        ) : (
          <div className="mt-1 flex items-center gap-3 rounded-md border bg-background p-2">
            <div className="size-16 shrink-0 overflow-hidden rounded border bg-muted">
              {/* biome-ignore lint/performance/noImgElement: blob URL preview */}
              <img src={staged.previewUrl} alt="" className="size-full object-cover" aria-hidden />
            </div>
            <span className="min-w-0 flex-1 truncate text-xs">{staged.file.name}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={clearStaged}
              aria-label="Remove photo"
              disabled={pending}
            >
              <X className="size-4" />
            </Button>
          </div>
        )}
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={pending || !room.trim()}>
          {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          {pending ? 'Saving…' : 'Add selection'}
        </Button>
      </div>
    </form>
  );
}

function SelectionRow({
  portalSlug,
  selection,
  onDeleted,
}: {
  portalSlug: string;
  selection: PortalSelection;
  onDeleted: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const isCustomer = selection.created_by === 'customer';
  const headline = [selection.brand, selection.name].filter(Boolean).join(' ');
  const detail = [selection.code, selection.finish].filter(Boolean).join(' • ');

  function handleDelete() {
    if (!window.confirm('Remove this selection?')) return;
    startTransition(async () => {
      const res = await deleteCustomerSelectionAction({
        portalSlug,
        selectionId: selection.id,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      onDeleted();
    });
  }

  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        {selection.image_url ? (
          // biome-ignore lint/performance/noImgElement: signed URL
          <img
            src={selection.image_url}
            alt=""
            className="size-16 shrink-0 rounded-md border object-cover"
            loading="lazy"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium">
              {selectionCategoryLabels[selection.category as SelectionCategory] ??
                selection.category}
            </span>
            {headline ? <span className="text-sm font-medium">{headline}</span> : null}
            {isCustomer ? (
              <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-800">
                Added by you
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {detail ? <span>{detail}</span> : null}
            {selection.supplier ? <span>{selection.supplier}</span> : null}
            {selection.sku ? <span>SKU {selection.sku}</span> : null}
            {selection.warranty_url ? (
              <a
                href={selection.warranty_url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-primary hover:underline"
              >
                Warranty info
              </a>
            ) : null}
          </div>
          {selection.notes ? (
            <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
              {selection.notes}
            </p>
          ) : null}
        </div>
        {isCustomer ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleDelete}
            disabled={pending}
            aria-label="Delete"
            className="-mr-1 size-7 shrink-0 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </li>
  );
}
