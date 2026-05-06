'use client';

/**
 * "Label this card" inline dialog. Triggered from a receipt row whose
 * OCR pulled a last4 the tenant hasn't registered yet. The dialog
 * captures label + kind + paid_by, calls labelCardAction, and returns
 * the saved row to the caller so it can splice the new source into its
 * picker list and apply it to siblings.
 *
 * Design:
 *   - last4 is fixed at open time (it's the whole point — we already
 *     know the digits from the receipt).
 *   - Three quick paid_by presets, plus a kind dropdown. Defaults
 *     biased toward "debit + business" because that's the common case;
 *     when the row was OCR'd as credit network the parent can pre-set
 *     `defaultKind` to credit.
 */

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { type LabelCardInput, labelCardAction } from '@/server/actions/payment-sources';

type Kind = LabelCardInput['kind'];
type PaidBy = LabelCardInput['paid_by'];
type Network = NonNullable<LabelCardInput['network']>;

export type LabelCardResult = {
  id: string;
  label: string;
  last4: string;
  kind: Kind;
  paid_by: PaidBy;
};

export function LabelCardDialog({
  open,
  onOpenChange,
  last4,
  defaultKind = 'debit',
  defaultNetwork = null,
  defaultPaidBy = 'personal_reimbursable',
  defaultLabel = '',
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  last4: string;
  defaultKind?: Kind;
  defaultNetwork?: Network | null;
  defaultPaidBy?: PaidBy;
  defaultLabel?: string;
  /** Called with the persisted source after a successful save. */
  onSaved: (saved: LabelCardResult) => void;
}) {
  const [label, setLabel] = useState(defaultLabel);
  const [kind, setKind] = useState<Kind>(defaultKind);
  const [paidBy, setPaidBy] = useState<PaidBy>(defaultPaidBy);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setLabel(defaultLabel);
    setKind(defaultKind);
    setPaidBy(defaultPaidBy);
    setError(null);
  }

  function submit() {
    const trimmed = label.trim();
    if (!trimmed) {
      setError('Pick a label so this card is easy to spot later.');
      return;
    }
    startTransition(async () => {
      const res = await labelCardAction({
        last4,
        label: trimmed,
        kind,
        paid_by: paidBy,
        network: defaultNetwork,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onSaved({
        id: res.source.id,
        label: res.source.label,
        last4: res.source.last4 ?? last4,
        kind: res.source.kind,
        paid_by: res.source.paid_by,
      });
      reset();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Label card ····{last4}</DialogTitle>
          <DialogDescription>
            Give this card a nickname so future receipts auto-tag. We&apos;ll apply your label to
            every receipt in this batch that paid with the same card.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="card-label">Nickname</Label>
            <Input
              id="card-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder='e.g. "JB Debit", "TD VISA"'
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="card-kind">Card type</Label>
            <select
              id="card-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as Kind)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="debit">Debit</option>
              <option value="credit">Credit</option>
              <option value="other">Other</option>
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Paid by</Label>
            <div className="grid grid-cols-3 gap-1 rounded-md border bg-muted/20 p-1">
              <PaidByButton
                active={paidBy === 'business'}
                onClick={() => setPaidBy('business')}
                label="Business"
                hint="Posts to bank/CC"
              />
              <PaidByButton
                active={paidBy === 'personal_reimbursable'}
                onClick={() => setPaidBy('personal_reimbursable')}
                label="Reimbursable"
                hint="Owner equity → reimburse"
              />
              <PaidByButton
                active={paidBy === 'petty_cash'}
                onClick={() => setPaidBy('petty_cash')}
                label="Petty cash"
                hint="From the cash float"
              />
            </div>
          </div>

          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={pending || !label.trim()}>
            {pending ? 'Saving…' : 'Save card'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PaidByButton({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-center gap-0.5 rounded px-2 py-2 text-center text-xs transition ${
        active ? 'bg-background shadow-sm ring-1 ring-primary' : 'hover:bg-background/60'
      }`}
    >
      <span className="font-medium">{label}</span>
      <span className="text-[10px] text-muted-foreground">{hint}</span>
    </button>
  );
}
