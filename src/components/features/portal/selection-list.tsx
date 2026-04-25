'use client';

/**
 * Operator-side list of project selections, grouped by room. Each row
 * has Edit (opens the form dialog) and Delete affordances. Rows
 * collapse into the Selections tab on the project detail page.
 */

import { Pencil, Trash2 } from 'lucide-react';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { ProjectSelection } from '@/lib/db/queries/project-selections';
import {
  type SelectionCategory,
  selectionCategoryLabels,
} from '@/lib/validators/project-selection';
import { deleteSelectionAction } from '@/server/actions/project-selections';
import { SelectionFormDialog } from './selection-form-dialog';
import { type GalleryPickerPhoto, SelectionPhotoPicker } from './selection-photo-picker';

const cad = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

function computeVariance(
  allowance: number | null,
  actual: number | null,
): { tone: 'over' | 'under' | 'flat'; label: string } | null {
  if (allowance == null && actual == null) return null;
  if (allowance == null && actual != null)
    return { tone: 'flat', label: `Cost ${cad.format(actual / 100)}` };
  if (allowance != null && actual == null)
    return { tone: 'flat', label: `Allowance ${cad.format(allowance / 100)}` };
  const a = allowance as number;
  const c = actual as number;
  if (c > a) return { tone: 'over', label: `+${cad.format((c - a) / 100)} over allowance` };
  if (c < a) return { tone: 'under', label: `${cad.format((a - c) / 100)} under` };
  return { tone: 'flat', label: 'On allowance' };
}

export function SelectionList({
  groups,
  projectId,
  galleryPhotos = [],
}: {
  groups: Array<{ room: string; items: ProjectSelection[] }>;
  projectId: string;
  galleryPhotos?: GalleryPickerPhoto[];
}) {
  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No selections captured yet. Add the paint codes, tile SKUs, and fixture models you use —
        they&rsquo;ll appear in the homeowner&rsquo;s portal and the final Home Record.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <div key={group.room} className="rounded-lg border bg-card">
          <div className="flex items-center justify-between border-b px-4 py-2">
            <h3 className="text-sm font-semibold">{group.room}</h3>
            <SelectionFormDialog
              projectId={projectId}
              defaultRoom={group.room}
              trigger={
                <button
                  type="button"
                  className="text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  + Add to this room
                </button>
              }
            />
          </div>
          <ul className="divide-y">
            {group.items.map((sel) => (
              <SelectionRow
                key={sel.id}
                selection={sel}
                projectId={projectId}
                galleryPhotos={galleryPhotos}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function SelectionRow({
  selection,
  projectId,
  galleryPhotos = [],
}: {
  selection: ProjectSelection;
  projectId: string;
  galleryPhotos?: GalleryPickerPhoto[];
}) {
  const [pending, startTransition] = useTransition();

  function onDelete() {
    if (!confirm(`Delete "${selection.name ?? selection.category}" from ${selection.room}?`)) {
      return;
    }
    startTransition(async () => {
      const res = await deleteSelectionAction(selection.id, projectId);
      if (!res.ok) toast.error(res.error);
    });
  }

  const headline = [selection.brand, selection.name].filter(Boolean).join(' ');
  const detail = [selection.code, selection.finish].filter(Boolean).join(' • ');
  const variance = computeVariance(selection.allowance_cents, selection.actual_cost_cents);

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium">
            {selectionCategoryLabels[selection.category as SelectionCategory] ?? selection.category}
          </span>
          {headline ? <span className="text-sm font-medium">{headline}</span> : null}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {detail ? <span>{detail}</span> : null}
          {selection.supplier ? <span>{selection.supplier}</span> : null}
          {selection.sku ? <span>SKU {selection.sku}</span> : null}
        </div>
        {variance ? (
          <p
            className={
              variance.tone === 'over'
                ? 'mt-1 text-xs font-medium text-rose-700'
                : variance.tone === 'under'
                  ? 'mt-1 text-xs font-medium text-emerald-700'
                  : 'mt-1 text-xs text-muted-foreground'
            }
          >
            {variance.label}
          </p>
        ) : null}
        {selection.notes ? (
          <p className="mt-1 text-xs text-muted-foreground">{selection.notes}</p>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        {galleryPhotos.length > 0 ? (
          <SelectionPhotoPicker
            selectionId={selection.id}
            projectId={projectId}
            photos={galleryPhotos}
            initialIds={selection.photo_refs.map((r) => r.photo_id)}
            count={selection.photo_refs.length}
          />
        ) : null}
        <SelectionFormDialog
          projectId={projectId}
          selection={selection}
          trigger={
            <Button type="button" size="icon" variant="ghost" aria-label="Edit selection">
              <Pencil className="size-4" />
            </Button>
          }
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Delete selection"
          onClick={onDelete}
          disabled={pending}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </li>
  );
}
