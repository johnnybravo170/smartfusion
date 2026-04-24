import { cn } from '@/lib/utils';
import {
  type ContactKind,
  type CustomerType,
  contactKindLabels,
  customerTypeLabels,
} from '@/lib/validators/customer';

/**
 * Compact kind / subtype pill. Colour-coded so the list scans fast.
 *
 * When `kind === 'customer'`, we show the subtype (residential / commercial).
 * Agent used to be a customer subtype; it's now its own kind, rendered in
 * its original violet. New non-customer kinds (vendor, sub, inspector,
 * referral, other) each get their own colour.
 */

const CUSTOMER_SUBTYPE_STYLES: Record<CustomerType, string> = {
  residential: 'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/40 dark:text-blue-300',
  commercial: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300',
  agent: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950/40 dark:text-violet-300',
};

const KIND_STYLES: Record<ContactKind, string> = {
  customer: 'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/40 dark:text-blue-300',
  vendor:
    'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300',
  sub: 'bg-cyan-50 text-cyan-700 ring-cyan-200 dark:bg-cyan-950/40 dark:text-cyan-300',
  agent: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950/40 dark:text-violet-300',
  inspector: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300',
  referral: 'bg-pink-50 text-pink-700 ring-pink-200 dark:bg-pink-950/40 dark:text-pink-300',
  other: 'bg-muted text-muted-foreground ring-transparent',
};

export function CustomerTypeBadge({
  type,
  kind,
  className,
}: {
  type: CustomerType;
  /**
   * Optional contact kind. When provided and not 'customer', the badge
   * renders the kind label instead of the legacy subtype.
   */
  kind?: ContactKind;
  className?: string;
}) {
  // Non-customer kind → show kind label with kind-coloured ring.
  if (kind && kind !== 'customer') {
    return (
      <span
        data-slot="customer-type-badge"
        data-kind={kind}
        className={cn(
          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
          KIND_STYLES[kind],
          className,
        )}
      >
        {contactKindLabels[kind]}
      </span>
    );
  }
  // Customer kind (or legacy call with only `type`) → show subtype.
  return (
    <span
      data-slot="customer-type-badge"
      data-type={type}
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        CUSTOMER_SUBTYPE_STYLES[type],
        className,
      )}
    >
      {customerTypeLabels[type]}
    </span>
  );
}
