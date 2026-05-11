'use client';

/**
 * Settings UI for payment sources. Lists every active source plus
 * a "Add source" affordance. Each row exposes:
 *   - Make default (for the tenant — flips the partial-unique-index)
 *   - Edit (label, kind, paid_by, last4, account code)
 *   - Archive (refused if it's the default)
 */

import { Plus, Star } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { PaymentSourcePill } from '@/components/features/payment-sources/payment-source-pill';
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
import type { PaymentSourceRow } from '@/lib/db/queries/payment-sources';
import {
  archivePaymentSourceAction,
  createPaymentSourceAction,
  setDefaultPaymentSourceAction,
  type UpsertPaymentSourceInput,
  updatePaymentSourceAction,
} from '@/server/actions/payment-sources';

export function PaymentSourcesManager({ sources }: { sources: PaymentSourceRow[] }) {
  const [editing, setEditing] = useState<PaymentSourceRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [pending, startTransition] = useTransition();

  function makeDefault(id: string) {
    startTransition(async () => {
      const res = await setDefaultPaymentSourceAction({ id });
      if (!res.ok) toast.error(res.error);
      else toast.success('Default updated.');
    });
  }

  function archive(s: PaymentSourceRow) {
    if (
      !confirm(
        `Archive "${s.label}"? Existing expenses keep this source attached; new entries can no longer pick it.`,
      )
    )
      return;
    startTransition(async () => {
      const res = await archivePaymentSourceAction({ id: s.id });
      if (!res.ok) toast.error(res.error);
      else toast.success('Archived.');
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Cards and other ways you pay for things. Henry auto-tags receipts by last 4.
        </p>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-3.5" />
          Add source
        </Button>
      </div>

      <ul className="flex flex-col gap-2">
        {sources.map((s) => (
          <li
            key={s.id}
            className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3"
          >
            <PaymentSourcePill source={s} />
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="capitalize">{s.kind}</span>
              <span>·</span>
              <span>{paidByDescription(s.paid_by)}</span>
              {s.default_account_code ? (
                <>
                  <span>·</span>
                  <span className="font-mono">{s.default_account_code}</span>
                </>
              ) : null}
              {s.is_default ? (
                <span className="ml-auto inline-flex items-center gap-1 text-xs text-foreground">
                  <Star className="size-3 fill-current" /> Default
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {!s.is_default ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => makeDefault(s.id)}
                >
                  Make default
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                Edit
              </Button>
              {!s.is_default ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-red-600 hover:text-red-700"
                  onClick={() => archive(s)}
                  disabled={pending}
                >
                  Archive
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <SourceDialog
        // Re-key so the dialog remounts (and reseeds its local state)
        // any time we switch between create/edit/different-row.
        key={editing?.id ?? (creating ? 'new' : 'closed')}
        open={creating || editing !== null}
        onOpenChange={(v) => {
          if (!v) {
            setCreating(false);
            setEditing(null);
          }
        }}
        initial={editing}
      />
    </div>
  );
}

function paidByDescription(p: PaymentSourceRow['paid_by']): string {
  if (p === 'business') return 'Business';
  if (p === 'personal_reimbursable') return 'Reimburse from petty cash';
  return 'Petty cash';
}

function SourceDialog({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial: PaymentSourceRow | null;
}) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [last4, setLast4] = useState(initial?.last4 ?? '');
  const [kind, setKind] = useState<UpsertPaymentSourceInput['kind']>(initial?.kind ?? 'debit');
  const [paidBy, setPaidBy] = useState<UpsertPaymentSourceInput['paid_by']>(
    initial?.paid_by ?? 'business',
  );
  const [accountCode, setAccountCode] = useState(initial?.default_account_code ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setLabel(initial?.label ?? '');
    setLast4(initial?.last4 ?? '');
    setKind(initial?.kind ?? 'debit');
    setPaidBy(initial?.paid_by ?? 'business');
    setAccountCode(initial?.default_account_code ?? '');
    setError(null);
  }

  function submit() {
    setError(null);
    const trimmed = label.trim();
    if (!trimmed) {
      setError('Label is required.');
      return;
    }
    if (last4 && !/^\d{4}$/.test(last4)) {
      setError('Last 4 must be exactly 4 digits.');
      return;
    }
    startTransition(async () => {
      const payload: UpsertPaymentSourceInput = {
        label: trimmed,
        last4: last4 || null,
        kind,
        paid_by: paidBy,
        default_account_code: accountCode.trim() || null,
        network: null,
      };
      const res = initial
        ? await updatePaymentSourceAction({ id: initial.id, ...payload })
        : await createPaymentSourceAction(payload);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      reset();
      onOpenChange(false);
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
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit source' : 'Add source'}</DialogTitle>
          <DialogDescription>
            {initial
              ? 'Tweak how this source is labeled or how it should be treated at QB sync time.'
              : 'Cards, cash, e-transfer, etc. — anything you use to pay for things.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="src-label">Label</Label>
            <Input
              id="src-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Business Visa, Personal debit, Truck card"
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="src-last4">Last 4 (optional)</Label>
              <Input
                id="src-last4"
                value={last4}
                onChange={(e) => setLast4(e.target.value.replace(/\D+/g, '').slice(0, 4))}
                placeholder="1234"
                inputMode="numeric"
                maxLength={4}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="src-kind">Kind</Label>
              <select
                id="src-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as UpsertPaymentSourceInput['kind'])}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="debit">Debit</option>
                <option value="credit">Credit</option>
                <option value="cash">Cash</option>
                <option value="etransfer">E-transfer</option>
                <option value="cheque">Cheque</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="src-paid-by">Paid by</Label>
            <select
              id="src-paid-by"
              value={paidBy}
              onChange={(e) => setPaidBy(e.target.value as UpsertPaymentSourceInput['paid_by'])}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="business">Business — bank/CC account</option>
              <option value="personal_reimbursable">Personal — reimburse from petty cash</option>
              <option value="petty_cash">Petty cash float</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="src-acc">
              Account code <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="src-acc"
              value={accountCode}
              onChange={(e) => setAccountCode(e.target.value)}
              placeholder="QB chart-of-accounts code, if known"
            />
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
            {pending ? 'Saving…' : initial ? 'Save' : 'Add source'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
