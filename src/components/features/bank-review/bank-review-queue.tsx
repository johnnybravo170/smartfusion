'use client';

/**
 * BR-7 — bank review queue. The slice where 50 manual "mark paid" clicks
 * become one bulk-confirm. Default-hides unmatched transactions.
 *
 * Each row:
 *   - Top match shown inline with a confidence badge.
 *   - "Other candidates" dropdown for the alternates (when present).
 *   - Bulk checkbox; high-confidence rows pre-checked.
 *   - Reject button ("not an invoice — it's a transfer/fee/etc").
 */

import { Check, Loader2, X } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { MatchCandidate } from '@/lib/bank-recon/matcher';
import type { BankReviewRow } from '@/lib/db/queries/bank-review-queue';
import { formatCurrency } from '@/lib/pricing/calculator';
import { cn } from '@/lib/utils';
import { confirmBankMatchesAction, rejectBankMatchesAction } from '@/server/actions/bank-confirm';

const KIND_LABEL: Record<MatchCandidate['kind'], string> = {
  invoice: 'invoice',
  expense: 'expense',
  bill: 'bill',
};

export function BankReviewQueue({
  initialRows,
  counts,
  statements,
  filters,
}: {
  initialRows: BankReviewRow[];
  counts: {
    suggested_high: number;
    suggested_medium: number;
    suggested_low: number;
    unmatched: number;
    confirmed: number;
    rejected: number;
  };
  statements: Array<{ id: string; source_label: string; uploaded_at: string }>;
  filters: { statement_id?: string; include_unmatched: boolean };
}) {
  const [rows, setRows] = useState(initialRows);
  // Per-row picked candidate index (0 = best, default).
  const [picks, setPicks] = useState<Record<string, number>>({});
  // Pre-check high-confidence rows; medium/low default off.
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const r of initialRows) {
      if (r.match_confidence === 'high') init[r.id] = true;
    }
    return init;
  });
  const [working, startWork] = useTransition();

  useEffect(() => {
    setRows(initialRows);
  }, [initialRows]);

  const checkedIds = Object.entries(checked)
    .filter(([, v]) => v)
    .map(([k]) => k);

  function toggleAll(value: boolean) {
    const next: Record<string, boolean> = {};
    for (const r of rows) {
      if (r.match_status === 'suggested') next[r.id] = value;
    }
    setChecked(next);
  }

  function confirmSelected() {
    if (checkedIds.length === 0) {
      toast.error('Pick at least one match.');
      return;
    }
    const confirmed = window.confirm(
      `Mark ${checkedIds.length} match${checkedIds.length === 1 ? '' : 'es'} as paid? Invoices and bills will flip to "paid"; expenses will be linked for audit.`,
    );
    if (!confirmed) return;

    const matches = checkedIds.map((id) => ({
      bank_tx_id: id,
      candidate_index: picks[id] ?? 0,
    }));

    startWork(async () => {
      const res = await confirmBankMatchesAction(matches);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const parts: string[] = [];
      if (res.invoices_paid > 0)
        parts.push(`${res.invoices_paid} invoice${res.invoices_paid === 1 ? '' : 's'} paid`);
      if (res.bills_paid > 0)
        parts.push(`${res.bills_paid} bill${res.bills_paid === 1 ? '' : 's'} paid`);
      if (res.expenses_linked > 0)
        parts.push(`${res.expenses_linked} expense${res.expenses_linked === 1 ? '' : 's'} linked`);
      toast.success(parts.length > 0 ? parts.join(' · ') : `${res.confirmed} confirmed`);
      // Drop the confirmed rows from local state for instant feedback.
      setRows((prev) => prev.filter((r) => !checkedIds.includes(r.id)));
      setChecked({});
    });
  }

  function rejectSelected() {
    if (checkedIds.length === 0) {
      toast.error('Pick at least one transaction.');
      return;
    }
    startWork(async () => {
      const res = await rejectBankMatchesAction(checkedIds);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`${res.rejected} marked as not-an-invoice`);
      setRows((prev) => prev.filter((r) => !checkedIds.includes(r.id)));
      setChecked({});
    });
  }

  function rejectOne(id: string) {
    startWork(async () => {
      const res = await rejectBankMatchesAction([id]);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setRows((prev) => prev.filter((r) => r.id !== id));
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 space-y-0">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Review queue</CardTitle>
          <CountSummary counts={counts} include_unmatched={filters.include_unmatched} />
        </div>
        <FilterBar statements={statements} filters={filters} />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {filters.statement_id
              ? 'Nothing to review for this statement. All matches confirmed or skipped.'
              : 'Nothing waiting. Import a bank statement to see suggested matches here.'}
          </p>
        ) : (
          <>
            <BulkBar
              checkedCount={checkedIds.length}
              totalCount={rows.filter((r) => r.match_status === 'suggested').length}
              working={working}
              onToggleAll={toggleAll}
              onConfirm={confirmSelected}
              onReject={rejectSelected}
            />
            <ul className="flex flex-col divide-y">
              {rows.map((row) => (
                <ReviewRow
                  key={row.id}
                  row={row}
                  picked={picks[row.id] ?? 0}
                  onPick={(i) => setPicks((prev) => ({ ...prev, [row.id]: i }))}
                  checked={!!checked[row.id]}
                  onCheck={(v) => setChecked((prev) => ({ ...prev, [row.id]: v }))}
                  onReject={() => rejectOne(row.id)}
                  disabled={working}
                />
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Header bits
// ---------------------------------------------------------------------------

function CountSummary({
  counts,
  include_unmatched,
}: {
  counts: {
    suggested_high: number;
    suggested_medium: number;
    suggested_low: number;
    unmatched: number;
    confirmed: number;
    rejected: number;
  };
  include_unmatched: boolean;
}) {
  const suggested = counts.suggested_high + counts.suggested_medium + counts.suggested_low;
  return (
    <div className="text-xs text-muted-foreground">
      <strong className="tabular-nums text-foreground">{suggested}</strong> to review
      {counts.unmatched > 0 && !include_unmatched ? (
        <>
          {' · '}
          {counts.unmatched} unmatched (those belong in QBO)
        </>
      ) : null}
      {counts.confirmed > 0 ? (
        <>
          {' · '}
          {counts.confirmed} done
        </>
      ) : null}
    </div>
  );
}

function FilterBar({
  statements,
  filters,
}: {
  statements: Array<{ id: string; source_label: string }>;
  filters: { statement_id?: string; include_unmatched: boolean };
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Select
        value={filters.statement_id ?? 'all'}
        onValueChange={(v) => {
          const url = new URL(window.location.href);
          if (v === 'all') url.searchParams.delete('statement');
          else url.searchParams.set('statement', v);
          window.location.href = url.toString();
        }}
      >
        <SelectTrigger className="h-8 w-auto min-w-[200px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statements</SelectItem>
          {statements.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.source_label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <label className="inline-flex items-center gap-1">
        <input
          type="checkbox"
          checked={filters.include_unmatched}
          onChange={(e) => {
            const url = new URL(window.location.href);
            if (e.target.checked) url.searchParams.set('include_unmatched', '1');
            else url.searchParams.delete('include_unmatched');
            window.location.href = url.toString();
          }}
        />
        Show unmatched
      </label>
    </div>
  );
}

function BulkBar({
  checkedCount,
  totalCount,
  working,
  onToggleAll,
  onConfirm,
  onReject,
}: {
  checkedCount: number;
  totalCount: number;
  working: boolean;
  onToggleAll: (v: boolean) => void;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const allChecked = checkedCount > 0 && checkedCount === totalCount;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
      <label className="inline-flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={allChecked}
          onChange={(e) => onToggleAll(e.target.checked)}
          disabled={working}
        />
        {checkedCount > 0 ? `${checkedCount} selected` : 'Select all'}
      </label>
      <div className="flex-1" />
      <Button size="sm" onClick={onConfirm} disabled={working || checkedCount === 0}>
        {working ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
        <span className="ml-1">Confirm + mark paid</span>
      </Button>
      <Button size="sm" variant="ghost" onClick={onReject} disabled={working || checkedCount === 0}>
        <X className="size-4" />
        <span className="ml-1">Not an invoice</span>
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function ReviewRow({
  row,
  picked,
  onPick,
  checked,
  onCheck,
  onReject,
  disabled,
}: {
  row: BankReviewRow;
  picked: number;
  onPick: (i: number) => void;
  checked: boolean;
  onCheck: (v: boolean) => void;
  onReject: () => void;
  disabled: boolean;
}) {
  const candidate = row.match_candidates[picked];
  const otherCandidates = row.match_candidates.slice(0, 3).filter((_, i) => i !== picked);
  const isOutflow = row.amount_cents < 0;

  return (
    <li
      className={cn(
        'grid grid-cols-[auto_100px_1fr_auto_auto] items-center gap-3 py-3 text-sm',
        disabled && 'opacity-60',
      )}
    >
      {row.match_status === 'suggested' ? (
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onCheck(e.target.checked)}
          disabled={disabled}
          aria-label="Select for bulk action"
        />
      ) : (
        <div className="size-4" />
      )}

      <div className="flex flex-col text-xs">
        <span className="font-medium tabular-nums text-foreground">{row.posted_at}</span>
        <span className="text-muted-foreground">{row.statement_label}</span>
      </div>

      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium" title={row.description}>
          {row.description}
        </span>
        {candidate ? (
          <span className="truncate text-xs text-muted-foreground">
            <ConfidenceBadge confidence={candidate.confidence} />
            <span className="ml-1.5">
              {isOutflow ? '→' : '←'} {KIND_LABEL[candidate.kind]} · {candidate.label} ·{' '}
              {formatCurrency(candidate.amount_cents)} · {candidate.tx_date}
            </span>
            {otherCandidates.length > 0 ? (
              <span className="ml-1.5">
                ·{' '}
                <CandidateSwitcher
                  candidates={row.match_candidates}
                  picked={picked}
                  onPick={onPick}
                />
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-xs italic text-muted-foreground">
            Unmatched · transfer / fee / interest? Reject to skip.
          </span>
        )}
      </div>

      <span
        className={cn(
          'tabular-nums font-semibold',
          isOutflow ? 'text-rose-700 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-400',
        )}
      >
        {formatCurrency(row.amount_cents)}
      </span>

      <Button size="sm" variant="ghost" onClick={onReject} disabled={disabled} aria-label="Reject">
        <X className="size-3.5" />
      </Button>
    </li>
  );
}

function ConfidenceBadge({ confidence }: { confidence: 'high' | 'medium' | 'low' }) {
  const tone =
    confidence === 'high'
      ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200'
      : confidence === 'medium'
        ? 'bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200'
        : 'bg-slate-100 text-slate-700 dark:bg-slate-800/40 dark:text-slate-300';
  return (
    <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase', tone)}>
      {confidence}
    </span>
  );
}

function CandidateSwitcher({
  candidates,
  picked,
  onPick,
}: {
  candidates: MatchCandidate[];
  picked: number;
  onPick: (i: number) => void;
}) {
  return (
    <Select value={String(picked)} onValueChange={(v) => onPick(Number(v))}>
      <SelectTrigger className="inline-flex h-6 w-auto px-1.5 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {candidates.slice(0, 3).map((c, i) => (
          <SelectItem key={`${c.kind}-${c.id}`} value={String(i)}>
            {c.label} · {formatCurrency(c.amount_cents)} ({c.confidence})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
