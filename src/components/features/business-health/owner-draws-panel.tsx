'use client';

/**
 * Owner draws panel — quick-add form + inline-editable ledger table.
 *
 * Optimistic-first: new rows appear before the server confirms; failures
 * surface a toast and roll back. Mirrors the team-checklist pattern.
 */

import { Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useOptimistic, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { OWNER_DRAW_TYPES, type OwnerDrawType } from '@/lib/db/schema/owner-draws';
import { formatCurrency } from '@/lib/pricing/calculator';
import { cn } from '@/lib/utils';
import {
  createOwnerDrawAction,
  deleteOwnerDrawAction,
  type OwnerDrawRow,
  updateOwnerDrawAction,
} from '@/server/actions/owner-draws';

const DRAW_TYPE_LABELS: Record<OwnerDrawType, string> = {
  salary: 'Salary',
  dividend: 'Dividend',
  reimbursement: 'Reimbursement',
  other: 'Other',
};

type OptimisticOp =
  | { kind: 'add'; row: OwnerDrawRow }
  | { kind: 'remove'; id: string }
  | { kind: 'update'; id: string; patch: Partial<OwnerDrawRow> };

function applyOp(rows: OwnerDrawRow[], op: OptimisticOp): OwnerDrawRow[] {
  switch (op.kind) {
    case 'add':
      return [op.row, ...rows].sort(byPaidAtDesc);
    case 'remove':
      return rows.filter((r) => r.id !== op.id);
    case 'update':
      return rows.map((r) => (r.id === op.id ? { ...r, ...op.patch } : r)).sort(byPaidAtDesc);
  }
}

function byPaidAtDesc(a: OwnerDrawRow, b: OwnerDrawRow): number {
  if (a.paid_at === b.paid_at) return b.created_at.localeCompare(a.created_at);
  return b.paid_at.localeCompare(a.paid_at);
}

function todayIsoDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseAmountToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Accepts "1234", "1234.56", "$1,234.56" — but rejects garbage.
  const cleaned = trimmed.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(parseFloat(cleaned) * 100);
  return cents > 0 ? cents : null;
}

// ---------------------------------------------------------------------------
// Panel root
// ---------------------------------------------------------------------------

export function OwnerDrawsPanel({
  initialRows,
  year,
}: {
  initialRows: OwnerDrawRow[];
  year: number;
}) {
  const [rows, applyOptimistic] = useOptimistic<OwnerDrawRow[], OptimisticOp>(initialRows, applyOp);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Owner draws · {year}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <AddDrawForm applyOptimistic={applyOptimistic} />
        {rows.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No draws recorded for {year}. Add a salary or dividend payment above.
          </p>
        ) : (
          <ul className="flex flex-col">
            {rows.map((row) => (
              <DrawRow key={row.id} row={row} applyOptimistic={applyOptimistic} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Add form
// ---------------------------------------------------------------------------

function AddDrawForm({ applyOptimistic }: { applyOptimistic: (op: OptimisticOp) => void }) {
  const [amount, setAmount] = useState('');
  const [drawType, setDrawType] = useState<OwnerDrawType>('salary');
  const [paidAt, setPaidAt] = useState(todayIsoDate());
  const [note, setNote] = useState('');
  const [pending, startTransition] = useTransition();

  function submit() {
    const cents = parseAmountToCents(amount);
    if (cents === null) {
      toast.error('Enter a positive amount.');
      return;
    }

    const tempId = `temp-${crypto.randomUUID()}`;
    const optimistic: OwnerDrawRow = {
      id: tempId,
      paid_at: paidAt,
      amount_cents: cents,
      draw_type: drawType,
      note: note.trim() || null,
      created_by: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    startTransition(async () => {
      applyOptimistic({ kind: 'add', row: optimistic });
      setAmount('');
      setNote('');
      const res = await createOwnerDrawAction({
        paid_at: paidAt,
        amount_cents: cents,
        draw_type: drawType,
        note: note.trim() || undefined,
      });
      if (!res.ok) {
        toast.error(res.error);
        applyOptimistic({ kind: 'remove', id: tempId });
      }
    });
  }

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_140px_140px_auto]">
      <Input
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Amount (e.g. 5000.00)"
        inputMode="decimal"
        disabled={pending}
        aria-label="Amount"
      />
      <Select
        value={drawType}
        onValueChange={(v) => setDrawType(v as OwnerDrawType)}
        disabled={pending}
      >
        <SelectTrigger aria-label="Draw type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {OWNER_DRAW_TYPES.map((t) => (
            <SelectItem key={t} value={t}>
              {DRAW_TYPE_LABELS[t]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        type="date"
        value={paidAt}
        onChange={(e) => setPaidAt(e.target.value)}
        disabled={pending}
        aria-label="Date paid"
      />
      <div className="flex gap-2">
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
          disabled={pending}
          aria-label="Note"
          className="flex-1 sm:hidden"
        />
        <Button onClick={submit} disabled={pending || !amount.trim()} className="shrink-0">
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
          <span className="ml-1">Add draw</span>
        </Button>
      </div>
      <Input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)"
        disabled={pending}
        aria-label="Note"
        className="hidden sm:col-span-4 sm:block"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function DrawRow({
  row,
  applyOptimistic,
}: {
  row: OwnerDrawRow;
  applyOptimistic: (op: OptimisticOp) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);

  function remove() {
    if (!confirm('Delete this draw?')) return;
    startTransition(async () => {
      applyOptimistic({ kind: 'remove', id: row.id });
      const res = await deleteOwnerDrawAction(row.id);
      if (!res.ok) {
        toast.error(res.error);
      }
    });
  }

  if (editing) {
    return (
      <EditDrawRow
        row={row}
        onCancel={() => setEditing(false)}
        onSave={(patch) => {
          startTransition(async () => {
            applyOptimistic({ kind: 'update', id: row.id, patch });
            setEditing(false);
            const res = await updateOwnerDrawAction({ id: row.id, ...patch });
            if (!res.ok) toast.error(res.error);
          });
        }}
      />
    );
  }

  return (
    <li
      className={cn(
        'grid grid-cols-[110px_120px_1fr_auto] items-center gap-2 border-b py-2 last:border-0 transition-opacity',
        pending && 'opacity-60',
      )}
    >
      <span className="text-sm text-muted-foreground tabular-nums">{row.paid_at}</span>
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {DRAW_TYPE_LABELS[row.draw_type]}
      </span>
      <div className="min-w-0 flex flex-col">
        <span className="font-semibold tabular-nums">{formatCurrency(row.amount_cents)}</span>
        {row.note ? (
          <span className="truncate text-xs text-muted-foreground">{row.note}</span>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        <Button
          size="icon"
          variant="ghost"
          onClick={() => setEditing(true)}
          disabled={pending}
          aria-label="Edit"
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button size="icon" variant="ghost" onClick={remove} disabled={pending} aria-label="Delete">
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}

function EditDrawRow({
  row,
  onCancel,
  onSave,
}: {
  row: OwnerDrawRow;
  onCancel: () => void;
  onSave: (patch: {
    paid_at: string;
    amount_cents: number;
    draw_type: OwnerDrawType;
    note: string | null;
  }) => void;
}) {
  const [paidAt, setPaidAt] = useState(row.paid_at);
  const [amount, setAmount] = useState((row.amount_cents / 100).toFixed(2));
  const [drawType, setDrawType] = useState<OwnerDrawType>(row.draw_type);
  const [note, setNote] = useState(row.note ?? '');

  function save() {
    const cents = parseAmountToCents(amount);
    if (cents === null) {
      toast.error('Enter a positive amount.');
      return;
    }
    onSave({
      paid_at: paidAt,
      amount_cents: cents,
      draw_type: drawType,
      note: note.trim() || null,
    });
  }

  return (
    <li className="border-b py-2 last:border-0">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[140px_140px_1fr_auto]">
        <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
        <Select value={drawType} onValueChange={(v) => setDrawType(v as OwnerDrawType)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OWNER_DRAW_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {DRAW_TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount"
          inputMode="decimal"
        />
        <div className="flex gap-1">
          <Button size="sm" onClick={save}>
            Save
          </Button>
          <Button size="icon" variant="ghost" onClick={onCancel} aria-label="Cancel">
            <X className="size-4" />
          </Button>
        </div>
      </div>
      <Input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)"
        className="mt-2"
      />
    </li>
  );
}
