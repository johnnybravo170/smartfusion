'use client';

/**
 * Compact display pill for a payment source. Used in:
 *   - Bulk receipt wizard's Source column
 *   - Single receipt form (read-only display next to the picker)
 *   - Expenses list table
 *
 * Tone follows `paid_by`:
 *   - business              → neutral (no special color)
 *   - personal_reimbursable → amber (loud — unreimbursed money out of pocket)
 *   - petty_cash            → blue   (informational)
 */

import { CreditCard, HandCoins, Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';

export type PaymentSourcePillData = {
  label: string;
  last4: string | null;
  paid_by: 'business' | 'personal_reimbursable' | 'petty_cash';
  kind: 'debit' | 'credit' | 'cash' | 'etransfer' | 'cheque' | 'other';
};

export function PaymentSourcePill({
  source,
  className,
  size = 'sm',
}: {
  source: PaymentSourcePillData;
  className?: string;
  size?: 'xs' | 'sm';
}) {
  const tone =
    source.paid_by === 'personal_reimbursable'
      ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200'
      : source.paid_by === 'petty_cash'
        ? 'border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200'
        : 'border-input bg-muted/40 text-foreground';
  const Icon = iconForKind(source.kind);
  const padding = size === 'xs' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-xs';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border font-medium',
        padding,
        tone,
        className,
      )}
      title={pillTitle(source)}
    >
      <Icon className="size-3" aria-hidden />
      <span className="truncate">{source.label}</span>
      {source.last4 ? <span className="font-normal opacity-70">····{source.last4}</span> : null}
    </span>
  );
}

function iconForKind(kind: PaymentSourcePillData['kind']) {
  if (kind === 'cash') return Wallet;
  if (kind === 'etransfer' || kind === 'cheque') return HandCoins;
  return CreditCard;
}

function pillTitle(s: PaymentSourcePillData): string {
  const paid =
    s.paid_by === 'personal_reimbursable'
      ? 'Reimbursable — paid from personal funds'
      : s.paid_by === 'petty_cash'
        ? 'Petty cash'
        : 'Business';
  const last4 = s.last4 ? ` ····${s.last4}` : '';
  return `${s.label}${last4} · ${paid}`;
}
