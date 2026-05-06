'use client';

/**
 * Modal form for creating or editing a per-room material selection.
 * Same dialog shape for both — passing `selection` switches it into
 * edit mode. Used on the project detail Selections tab.
 */

import { Loader2, Plus } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { ProjectSelection } from '@/lib/db/queries/project-selections';
import {
  SELECTION_CATEGORIES,
  type SelectionCategory,
  selectionCategoryLabels,
} from '@/lib/validators/project-selection';
import { createSelectionAction, updateSelectionAction } from '@/server/actions/project-selections';

/**
 * Subset of selection fields that can be pre-filled via `initialValues`.
 * Used by promote-from-idea-board: we ship a partial set, the operator
 * fills the rest. Distinct from `selection` which signals "edit this
 * existing row" (which keeps the form in edit mode + targets update RPC).
 */
export type SelectionFormInitialValues = Partial<{
  room: string;
  category: SelectionCategory;
  brand: string;
  name: string;
  code: string;
  finish: string;
  supplier: string;
  sku: string;
  warranty_url: string;
  notes: string;
}>;

type Props = {
  projectId: string;
  /** Pre-fill room name when adding a selection from a specific room's "+ Add" button. */
  defaultRoom?: string;
  /** When provided, edits the existing row instead of creating new. */
  selection?: ProjectSelection;
  /** Custom trigger; when omitted, renders a default "Add selection" button. */
  trigger?: React.ReactNode;
  /** Pre-fill the create form (ignored when `selection` is set). */
  initialValues?: SelectionFormInitialValues;
  /** Optional override of the dialog's title — useful for "Promote to selection" framing. */
  title?: string;
  /** Optional override of the dialog's description copy. */
  description?: string;
  /** Fired AFTER a successful create — receives the new selection's id. Lets callers stamp linked rows (e.g. mark an idea-board item as promoted). */
  onAfterCreate?: (selectionId: string) => void | Promise<void>;
  /** Controlled-open variant: when supplied, owner controls the open state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function SelectionFormDialog({
  projectId,
  defaultRoom,
  selection,
  trigger,
  initialValues,
  title: titleOverride,
  description: descriptionOverride,
  onAfterCreate,
  open: openProp,
  onOpenChange,
}: Props) {
  const editing = Boolean(selection);
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => {
    onOpenChange?.(next);
    if (openProp === undefined) setOpenState(next);
  };
  const [room, setRoom] = useState(selection?.room ?? initialValues?.room ?? defaultRoom ?? '');
  const [category, setCategory] = useState<SelectionCategory>(
    (selection?.category as SelectionCategory | undefined) ?? initialValues?.category ?? 'paint',
  );
  const [brand, setBrand] = useState(selection?.brand ?? initialValues?.brand ?? '');
  const [name, setName] = useState(selection?.name ?? initialValues?.name ?? '');
  const [code, setCode] = useState(selection?.code ?? initialValues?.code ?? '');
  const [finish, setFinish] = useState(selection?.finish ?? initialValues?.finish ?? '');
  const [supplier, setSupplier] = useState(selection?.supplier ?? initialValues?.supplier ?? '');
  const [sku, setSku] = useState(selection?.sku ?? initialValues?.sku ?? '');
  const [warrantyUrl, setWarrantyUrl] = useState(
    selection?.warranty_url ?? initialValues?.warranty_url ?? '',
  );
  const [notes, setNotes] = useState(selection?.notes ?? initialValues?.notes ?? '');
  const [allowance, setAllowance] = useState(
    selection?.allowance_cents != null ? (selection.allowance_cents / 100).toFixed(2) : '',
  );
  const [actualCost, setActualCost] = useState(
    selection?.actual_cost_cents != null ? (selection.actual_cost_cents / 100).toFixed(2) : '',
  );
  const [pending, startTransition] = useTransition();

  function reset() {
    if (editing) return; // edits keep their values
    setRoom(initialValues?.room ?? defaultRoom ?? '');
    setCategory(initialValues?.category ?? 'paint');
    setBrand(initialValues?.brand ?? '');
    setName(initialValues?.name ?? '');
    setCode(initialValues?.code ?? '');
    setFinish(initialValues?.finish ?? '');
    setSupplier(initialValues?.supplier ?? '');
    setSku(initialValues?.sku ?? '');
    setWarrantyUrl(initialValues?.warranty_url ?? '');
    setNotes(initialValues?.notes ?? '');
    setAllowance('');
    setActualCost('');
  }

  function dollarsToCents(input: string): number | null {
    const trimmed = input.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const payload = {
        room,
        category,
        brand,
        name,
        code,
        finish,
        supplier,
        sku,
        warranty_url: warrantyUrl,
        notes,
        allowance_cents: dollarsToCents(allowance),
        actual_cost_cents: dollarsToCents(actualCost),
      };
      // `editing` is set iff `selection` exists, but TS can't prove
      // the linkage across props. Narrow explicitly so we can call
      // updateSelectionAction with a real string id (avoids biome's
      // noNonNullAssertion auto-fix turning `selection!.id` into
      // `selection?.id`, which silently broke the type contract).
      let res: Awaited<ReturnType<typeof createSelectionAction>>;
      if (editing) {
        if (!selection) {
          toast.error('Cannot edit: selection record missing.');
          return;
        }
        res = await updateSelectionAction(selection.id, projectId, payload);
      } else {
        res = await createSelectionAction(projectId, payload);
      }
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(editing ? 'Selection updated' : 'Selection added');
      const newId = !editing && 'id' in res ? (res.id ?? null) : null;
      if (!editing && newId && onAfterCreate) {
        try {
          await onAfterCreate(newId);
        } catch (err) {
          console.error('[selection-form] onAfterCreate failed:', err);
        }
      }
      reset();
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger || openProp === undefined ? (
        <DialogTrigger asChild>
          {trigger ?? (
            <Button type="button" size="sm" variant="outline">
              <Plus className="size-4" />
              Add selection
            </Button>
          )}
        </DialogTrigger>
      ) : null}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {titleOverride ?? (editing ? 'Edit selection' : 'Add selection')}
          </DialogTitle>
          <DialogDescription>
            {descriptionOverride ??
              'Captures what was used in this room — paint codes, tile SKUs, finish, supplier.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="sel-room">Room</Label>
              <Input
                id="sel-room"
                value={room}
                onChange={(e) => setRoom(e.target.value)}
                placeholder="e.g. Main bathroom"
                required
                autoFocus
              />
            </div>
            <div>
              <Label htmlFor="sel-category">Category</Label>
              <select
                id="sel-category"
                value={category}
                onChange={(e) => setCategory(e.target.value as SelectionCategory)}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                {SELECTION_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {selectionCategoryLabels[c]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="sel-brand">Brand</Label>
              <Input
                id="sel-brand"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                placeholder="Benjamin Moore"
              />
            </div>
            <div>
              <Label htmlFor="sel-name">Name</Label>
              <Input
                id="sel-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Simply White"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="sel-code">Code</Label>
              <Input
                id="sel-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="OC-117"
              />
            </div>
            <div>
              <Label htmlFor="sel-finish">Finish</Label>
              <Input
                id="sel-finish"
                value={finish}
                onChange={(e) => setFinish(e.target.value)}
                placeholder="eggshell"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="sel-supplier">Supplier</Label>
              <Input
                id="sel-supplier"
                value={supplier}
                onChange={(e) => setSupplier(e.target.value)}
                placeholder="Home Depot"
              />
            </div>
            <div>
              <Label htmlFor="sel-sku">SKU / model #</Label>
              <Input id="sel-sku" value={sku} onChange={(e) => setSku(e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="sel-warranty">Warranty link (optional)</Label>
            <Input
              id="sel-warranty"
              type="url"
              value={warrantyUrl}
              onChange={(e) => setWarrantyUrl(e.target.value)}
              placeholder="https://"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="sel-allowance">Allowance (optional)</Label>
              <Input
                id="sel-allowance"
                type="number"
                step="0.01"
                min="0"
                value={allowance}
                onChange={(e) => setAllowance(e.target.value)}
                placeholder="0.00"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">Budget for this pick</p>
            </div>
            <div>
              <Label htmlFor="sel-actual">Actual cost (optional)</Label>
              <Input
                id="sel-actual"
                type="number"
                step="0.01"
                min="0"
                value={actualCost}
                onChange={(e) => setActualCost(e.target.value)}
                placeholder="0.00"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">
                Real cost — variance shown if over
              </p>
            </div>
          </div>
          <div>
            <Label htmlFor="sel-notes">Notes (optional)</Label>
            <Textarea
              id="sel-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !room.trim()}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              {editing ? 'Save' : 'Add'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
