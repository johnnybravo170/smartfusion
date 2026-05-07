/**
 * Currency cell renderer used across budget / change-order tables.
 *
 * Three jobs:
 *   1. Mute the currency symbol — it's redundant in a $-only column.
 *   2. Render cents smaller + dimmer, like a superscript, so the
 *      integer dominates and whole-dollar values still line up with
 *      mixed-cent values column-to-column.
 *   3. Pad whole-dollar amounts with an INVISIBLE `.00` of the same
 *      width so the integer's right edge aligns across the column. No
 *      more "$4,190" and "$2,574.50" drifting in the same column.
 *
 * Used by `BudgetCategoriesTable` and the change-order edit form so
 * both screens render currency consistently.
 */

import { formatCurrencyCompact } from '@/lib/pricing/calculator';
import { cn } from '@/lib/utils';

export function Money({
  cents,
  className,
  emphasis,
  /**
   * When true, prefixes the value with a +/- sign and tints amber for
   * positive / emerald for negative deltas — the standard signed-delta
   * treatment used on change-order diffs.
   */
  signed,
}: {
  cents: number;
  className?: string;
  emphasis?: boolean;
  signed?: boolean;
}) {
  const text = formatCurrencyCompact(cents);
  // Pull symbol, integer, fraction out separately so we can style and
  // align them independently.
  const m = text.match(/^([^\d-]+)?(-?[\d,]+)(\.\d+)?$/);
  const symbol = m?.[1] ?? '';
  const integer = m?.[2] ?? text;
  const fraction = m?.[3] ?? null;

  const signClass = signed
    ? cents > 0
      ? 'text-amber-700'
      : cents < 0
        ? 'text-emerald-700'
        : 'text-muted-foreground'
    : undefined;

  return (
    <span
      className={cn(
        'whitespace-nowrap tabular-nums',
        emphasis && 'font-medium',
        signClass,
        className,
      )}
    >
      {signed && cents > 0 ? '+' : ''}
      <span className="text-muted-foreground/60">{symbol}</span>
      {integer}
      {fraction ? (
        <span className="text-[0.7em] text-muted-foreground/70">{fraction}</span>
      ) : (
        <span aria-hidden className="invisible text-[0.7em]">
          .00
        </span>
      )}
    </span>
  );
}
