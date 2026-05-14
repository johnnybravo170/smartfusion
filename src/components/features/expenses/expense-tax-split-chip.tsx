'use client';

/**
 * Tax-split confirmation chip shown below the expense Total field. Auto-
 * computes pre-tax + GST/HST from the tenant's effective rate so the
 * cost-plus markup base is correct without making the operator do math.
 *
 * Lifecycle:
 *   1. Operator types Total. Parent calls `recompute(totalCents)` on blur.
 *   2. Chip shows "✓ Pre-tax $X + N% tax $Y [Edit]".
 *   3. Operator clicks Edit → two editable inputs appear. Editing either
 *      pins the values (mode = 'manual'); the chip stops auto-recomputing
 *      when Total changes.
 *   4. "Reset" returns to mode = 'auto' and recomputes from current Total.
 *
 * OCR fills the values from the OCR result (mode = 'ocr'), and the chip
 * displays the same way as 'auto'. Hand-editing OCR'd values flips to
 * 'manual'. Total edits while in 'ocr' mode reset to 'auto'.
 *
 * The component is purely presentational + parent-controlled. The parent
 * owns the canonical state (preTaxCents, taxCents, mode) so the form
 * submit handler has direct access without touching refs.
 *
 * See PATTERNS.md §11 for usage rules.
 */

import { Check, Pencil, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { formatCurrency } from '@/lib/pricing/calculator';

export type TaxSplitMode = 'auto' | 'ocr' | 'manual';

type Props = {
  /** Pre-tax cents and tax cents to display. Null hides the chip. */
  preTaxCents: number | null;
  taxCents: number | null;
  /** Source of the current values. 'ocr' shows a "from receipt" hint. */
  mode: TaxSplitMode;
  /** Tenant's effective GST/HST rate, decimal (e.g. 0.13). Used for the
   *  rate label and the Reset → recompute path. */
  rate: number;
  /** Operator hand-edited the breakdown. Parent should set
   *  mode='manual' and persist the new values. */
  onManualChange: (next: { preTaxCents: number; taxCents: number }) => void;
  /** Operator wants to reset to auto-split from current Total. */
  onReset: () => void;
  disabled?: boolean;
};

function pct(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}

export function ExpenseTaxSplitChip(props: Props) {
  const [editing, setEditing] = useState(false);
  // Local edit state so the operator can type without firing onManualChange
  // on every keystroke. Committed on blur or Enter.
  const [draftPreTax, setDraftPreTax] = useState('');
  const [draftTax, setDraftTax] = useState('');

  if (props.preTaxCents === null || props.taxCents === null) return null;

  function startEdit() {
    if (props.disabled || props.preTaxCents === null || props.taxCents === null) return;
    setDraftPreTax((props.preTaxCents / 100).toFixed(2));
    setDraftTax((props.taxCents / 100).toFixed(2));
    setEditing(true);
  }

  function commit() {
    const preTax = Math.round(Number.parseFloat(draftPreTax) * 100);
    const tax = Math.round(Number.parseFloat(draftTax) * 100);
    if (Number.isFinite(preTax) && Number.isFinite(tax) && preTax >= 0 && tax >= 0) {
      props.onManualChange({ preTaxCents: preTax, taxCents: tax });
    }
    setEditing(false);
  }

  function cancel() {
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="mt-1 flex items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">Pre-tax</span>
        <Input
          type="number"
          min={0}
          step={0.01}
          value={draftPreTax}
          onChange={(e) => setDraftPreTax(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
            if (e.key === 'Escape') cancel();
          }}
          autoFocus
          className="h-7 w-20 text-xs"
          aria-label="Pre-tax amount"
        />
        <span className="text-muted-foreground">+ tax</span>
        <Input
          type="number"
          min={0}
          step={0.01}
          value={draftTax}
          onChange={(e) => setDraftTax(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
            if (e.key === 'Escape') cancel();
          }}
          className="h-7 w-20 text-xs"
          aria-label="Tax amount"
        />
        <button
          type="button"
          onClick={commit}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Save breakdown"
        >
          <Check className="size-3.5" />
        </button>
      </div>
    );
  }

  // Compact display — chip below the Total field.
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <Check className="size-3 text-emerald-600" />
      <span>
        Pre-tax{' '}
        <span className="font-medium text-foreground">{formatCurrency(props.preTaxCents)}</span> +{' '}
        {pct(props.rate)} tax{' '}
        <span className="font-medium text-foreground">{formatCurrency(props.taxCents)}</span>
      </span>
      {props.mode === 'ocr' ? <span className="text-[10px] uppercase">from receipt</span> : null}
      {props.mode === 'manual' ? (
        <button
          type="button"
          onClick={props.onReset}
          disabled={props.disabled}
          className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 hover:bg-muted hover:text-foreground"
          aria-label="Reset to auto-split"
        >
          <RefreshCw className="size-3" /> Reset
        </button>
      ) : (
        <button
          type="button"
          onClick={startEdit}
          disabled={props.disabled}
          className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 hover:bg-muted hover:text-foreground"
          aria-label="Edit tax breakdown"
        >
          <Pencil className="size-3" /> Edit
        </button>
      )}
    </div>
  );
}
