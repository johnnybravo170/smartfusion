'use client';

/**
 * Horizontal phase rail — the homeowner-facing "you are here" milestone
 * tracker that sits above the portal updates feed. NOT a Gantt; pills are
 * equal width and date ranges only show on the active step.
 *
 * Tap a pill to expand its phase panel below: shows the phase status +
 * any photos pinned to that phase via the operator's PhotoPortalButton.
 *
 * Used in two places:
 *   1. /portal/<slug> public page — read-only (no callbacks)
 *   2. Project detail Portal tab — operator advances/regresses, and now
 *      can enter Edit mode to add / rename / reorder / delete phases on
 *      this project. Edit affordances never show on the public page.
 */

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Check, ChevronLeft, ChevronRight, GripVertical, Loader2, Plus, X } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { ProjectPhase } from '@/lib/db/queries/project-phases';
import { cn } from '@/lib/utils';
import {
  advancePhaseAction,
  createPhaseAction,
  deletePhaseAction,
  regressPhaseAction,
  renamePhaseAction,
  reorderPhasesAction,
} from '@/server/actions/project-phases';

export type PhaseRailPhoto = {
  id: string;
  phase_id: string;
  url: string;
  caption: string | null;
};

type PhaseRailProps = {
  phases: ProjectPhase[];
  /**
   * When provided, the rail renders advance / regress / edit controls.
   * Omit for the public portal where homeowners only read.
   */
  projectId?: string;
  /**
   * Phase-pinned photos. Empty omits the expand-on-tap behaviour. The
   * pill is still labelled with status; clicking just no-ops.
   */
  phasePhotos?: PhaseRailPhoto[];
};

export function PhaseRail({ phases, projectId, phasePhotos = [] }: PhaseRailProps) {
  const [isPending, startTransition] = useTransition();
  const [expandedPhaseId, setExpandedPhaseId] = useState<string | null>(null);
  const [openPhotoUrl, setOpenPhotoUrl] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // Optimistic reorder. Null = use server order from `phases`. After the
  // server revalidates, lines identity changes and we reset to null.
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectPhase | null>(null);
  const editable = Boolean(projectId);

  // Reset optimistic order when fresh server data arrives.
  // biome-ignore lint/correctness/useExhaustiveDependencies: phases identity is the trigger
  useEffect(() => {
    setLocalOrder(null);
  }, [phases]);

  const orderedPhases = (() => {
    if (!localOrder) return phases;
    const byId = new Map(phases.map((p) => [p.id, p]));
    return localOrder.map((id) => byId.get(id)).filter((x): x is ProjectPhase => x !== undefined);
  })();

  // Bucket photos by phase for fast lookup.
  const photosByPhase = new Map<string, PhaseRailPhoto[]>();
  for (const photo of phasePhotos) {
    const list = photosByPhase.get(photo.phase_id) ?? [];
    list.push(photo);
    photosByPhase.set(photo.phase_id, list);
  }

  function onAdvance() {
    if (!projectId) return;
    startTransition(async () => {
      const res = await advancePhaseAction(projectId);
      if (!res.ok) toast.error(res.error);
    });
  }
  function onRegress() {
    if (!projectId) return;
    startTransition(async () => {
      const res = await regressPhaseAction(projectId);
      if (!res.ok) toast.error(res.error);
    });
  }

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    if (!projectId) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = orderedPhases.map((p) => p.id);
    const fromIdx = ids.indexOf(String(active.id));
    const toIdx = ids.indexOf(String(over.id));
    if (fromIdx === -1 || toIdx === -1) return;

    const next = [...ids];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, String(active.id));

    const previous = localOrder;
    setLocalOrder(next);
    startTransition(async () => {
      const res = await reorderPhasesAction({ projectId, orderedIds: next });
      if (!res.ok) {
        setLocalOrder(previous);
        toast.error(res.error);
      }
    });
  }

  function onAddPhase(name: string, afterPhaseId?: string) {
    if (!projectId) return;
    startTransition(async () => {
      const res = await createPhaseAction({ projectId, name, afterPhaseId });
      if (!res.ok) toast.error(res.error);
    });
  }

  function onRename(phaseId: string, name: string) {
    startTransition(async () => {
      const res = await renamePhaseAction({ phaseId, name });
      if (!res.ok) toast.error(res.error);
    });
  }

  function confirmDelete() {
    if (!pendingDelete) return;
    const phaseId = pendingDelete.id;
    setPendingDelete(null);
    startTransition(async () => {
      const res = await deletePhaseAction(phaseId);
      if (!res.ok) toast.error(res.error);
    });
  }

  const currentIdx = orderedPhases.findIndex((p) => p.status === 'in_progress');
  const currentPhase = currentIdx >= 0 ? orderedPhases[currentIdx] : null;
  const allComplete =
    orderedPhases.length > 0 && orderedPhases.every((p) => p.status === 'complete');

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Project phase</h3>
          <p className="text-xs text-muted-foreground">
            {editing
              ? 'Add, rename, reorder, or remove phases. Drag pills to reorder.'
              : allComplete
                ? 'All phases complete.'
                : currentPhase
                  ? `Currently in: ${currentPhase.name}`
                  : 'Not started.'}
          </p>
        </div>
        {editable ? (
          <div className="flex items-center gap-2">
            {editing ? (
              <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>
                Done
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditing(true)}
                  disabled={isPending}
                >
                  Edit phases
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onRegress}
                  disabled={isPending}
                  aria-label="Move to previous phase"
                >
                  <ChevronLeft className="size-4" />
                  Back
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={onAdvance}
                  disabled={isPending || allComplete}
                  aria-label="Advance to next phase"
                >
                  {isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ChevronRight className="size-4" />
                  )}
                  Advance
                </Button>
              </>
            )}
          </div>
        ) : null}
      </div>

      {editing ? (
        <DndContext
          sensors={dndSensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={orderedPhases.map((p) => p.id)}
            strategy={horizontalListSortingStrategy}
          >
            <ol
              className="mt-4 flex min-w-0 items-stretch gap-1 overflow-x-auto pb-1"
              aria-label="Project phases (edit mode)"
            >
              {orderedPhases.map((p) => (
                <EditablePhasePill
                  key={p.id}
                  phase={p}
                  onRename={(name) => onRename(p.id, name)}
                  onDelete={() => setPendingDelete(p)}
                  disabled={isPending}
                />
              ))}
              <li className="flex min-w-[8rem] flex-1 items-stretch">
                <AddPhaseInline onAdd={(name) => onAddPhase(name)} disabled={isPending} />
              </li>
            </ol>
          </SortableContext>
        </DndContext>
      ) : (
        <ol
          className="mt-4 flex min-w-0 items-stretch gap-1 overflow-x-auto pb-1"
          aria-label="Project phases"
        >
          {orderedPhases.map((p) => {
            const isCurrent = p.status === 'in_progress';
            const isComplete = p.status === 'complete';
            const photos = photosByPhase.get(p.id) ?? [];
            const isExpanded = expandedPhaseId === p.id;
            const expandable = photos.length > 0;
            return (
              <li
                key={p.id}
                aria-current={isCurrent ? 'step' : undefined}
                className={cn(
                  'flex min-w-[7rem] flex-1 flex-col items-stretch overflow-hidden rounded-md border text-center text-xs font-medium',
                  isCurrent && 'border-primary bg-primary/10 text-primary ring-2 ring-primary/30',
                  isComplete &&
                    'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200',
                  !isCurrent && !isComplete && 'border-muted bg-muted/40 text-muted-foreground',
                )}
              >
                <button
                  type="button"
                  onClick={() => setExpandedPhaseId(isExpanded ? null : expandable ? p.id : null)}
                  disabled={!expandable}
                  className={cn(
                    'flex w-full items-center justify-center gap-1.5 px-3 py-2',
                    expandable && 'cursor-pointer hover:bg-black/[0.03]',
                    !expandable && 'cursor-default',
                  )}
                  aria-expanded={expandable ? isExpanded : undefined}
                >
                  {isComplete ? <Check className="size-3.5" aria-hidden /> : null}
                  <span className="truncate">{p.name}</span>
                  {expandable ? (
                    <span className="ml-1 inline-flex size-4 items-center justify-center rounded-full bg-black/10 text-[10px] tabular-nums">
                      {photos.length}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {!editing && expandedPhaseId ? (
        <div className="mt-3 rounded-md border bg-muted/20 p-3">
          <p className="mb-2 text-xs font-medium">
            Photos from {orderedPhases.find((p) => p.id === expandedPhaseId)?.name}
          </p>
          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-6">
            {(photosByPhase.get(expandedPhaseId) ?? []).map((photo) => (
              <button
                key={photo.id}
                type="button"
                className="block aspect-square overflow-hidden rounded-md border bg-background"
                onClick={() => setOpenPhotoUrl(photo.url)}
                aria-label={photo.caption ?? 'Open photo'}
              >
                {/* biome-ignore lint/performance/noImgElement: signed URLs */}
                <img
                  src={photo.url}
                  alt={photo.caption ?? ''}
                  loading="lazy"
                  className="size-full object-cover"
                />
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <Dialog open={!!openPhotoUrl} onOpenChange={(o) => !o && setOpenPhotoUrl(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogTitle className="sr-only">Photo</DialogTitle>
          {openPhotoUrl ? (
            // biome-ignore lint/performance/noImgElement: signed URLs
            <img
              src={openPhotoUrl}
              alt=""
              className="max-h-[70vh] w-full rounded-md object-contain"
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove phase?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `"${pendingDelete.name}" will be removed from this project's rail. Existing phase status (in progress, complete) won't be affected for other phases.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EditablePhasePill({
  phase,
  onRename,
  onDelete,
  disabled,
}: {
  phase: ProjectPhase;
  onRename: (name: string) => void;
  onDelete: () => void;
  disabled?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: phase.id,
  });
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState(phase.name);

  useEffect(() => {
    setDraftName(phase.name);
  }, [phase.name]);

  const isCurrent = phase.status === 'in_progress';
  const isComplete = phase.status === 'complete';

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  function commitRename() {
    const trimmed = draftName.trim();
    if (!trimmed) {
      setDraftName(phase.name);
      setIsRenaming(false);
      return;
    }
    if (trimmed !== phase.name) onRename(trimmed);
    setIsRenaming(false);
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        'group relative flex min-w-[8rem] flex-1 flex-col items-stretch overflow-hidden rounded-md border text-center text-xs font-medium',
        isCurrent && 'border-primary bg-primary/10 text-primary ring-2 ring-primary/30',
        isComplete &&
          'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200',
        !isCurrent && !isComplete && 'border-muted bg-muted/40',
      )}
    >
      <div className="flex items-center gap-1 px-1.5 py-1.5">
        <button
          type="button"
          className="cursor-grab touch-none p-0.5 text-muted-foreground hover:text-foreground active:cursor-grabbing"
          aria-label="Drag to reorder"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" />
        </button>
        {isRenaming ? (
          <Input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRename();
              } else if (e.key === 'Escape') {
                setDraftName(phase.name);
                setIsRenaming(false);
              }
            }}
            // biome-ignore lint/a11y/noAutofocus: rename pattern is keyboard-only entry
            autoFocus
            className="h-6 px-1 text-xs"
            disabled={disabled}
          />
        ) : (
          <button
            type="button"
            className="flex-1 truncate text-left hover:underline disabled:no-underline"
            onClick={() => setIsRenaming(true)}
            disabled={disabled}
            aria-label={`Rename ${phase.name}`}
          >
            <span className="inline-flex items-center gap-1">
              {isComplete ? <Check className="size-3.5" aria-hidden /> : null}
              <span className="truncate">{phase.name}</span>
            </span>
          </button>
        )}
        <button
          type="button"
          className="rounded p-0.5 text-muted-foreground opacity-60 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
          onClick={onDelete}
          disabled={disabled}
          aria-label={`Remove ${phase.name}`}
        >
          <X className="size-3.5" />
        </button>
      </div>
    </li>
  );
}

function AddPhaseInline({
  onAdd,
  disabled,
}: {
  onAdd: (name: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');

  function commit() {
    const trimmed = value.trim();
    if (trimmed) onAdd(trimmed);
    setValue('');
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-muted-foreground/40 px-3 py-2 text-xs text-muted-foreground hover:border-muted-foreground hover:text-foreground"
      >
        <Plus className="size-3.5" />
        Add phase
      </button>
    );
  }
  return (
    <Input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          setValue('');
          setOpen(false);
        }
      }}
      placeholder="Phase name"
      // biome-ignore lint/a11y/noAutofocus: opens-on-click pattern
      autoFocus
      className="h-9 text-xs"
      disabled={disabled}
    />
  );
}
