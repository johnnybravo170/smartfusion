'use client';

import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Shared print button. Triggers the browser print dialog for the current
 * page. Pair with `@media print` CSS on the page to hide navigation/buttons
 * when printing.
 */
export function PrintButton({
  label = 'Print',
  variant = 'outline',
  size = 'sm',
}: {
  label?: string;
  variant?: 'default' | 'outline' | 'ghost';
  size?: 'default' | 'sm' | 'lg' | 'icon';
}) {
  return (
    <Button variant={variant} size={size} onClick={() => window.print()} className="no-print">
      <Printer className="size-3.5" />
      {label}
    </Button>
  );
}
