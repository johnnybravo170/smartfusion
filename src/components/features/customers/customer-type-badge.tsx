import { cn } from '@/lib/utils';
import { type CustomerType, customerTypeLabels } from '@/lib/validators/customer';

const TYPE_STYLES: Record<CustomerType, string> = {
  residential: 'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/40 dark:text-blue-300',
  commercial: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300',
  agent: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950/40 dark:text-violet-300',
};

/**
 * Compact customer-type pill. Colour-coded so Will can scan the list fast:
 * blue = homeowner, amber = commercial, violet = real-estate agent.
 */
export function CustomerTypeBadge({ type, className }: { type: CustomerType; className?: string }) {
  return (
    <span
      data-slot="customer-type-badge"
      data-type={type}
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        TYPE_STYLES[type],
        className,
      )}
    >
      {customerTypeLabels[type]}
    </span>
  );
}
