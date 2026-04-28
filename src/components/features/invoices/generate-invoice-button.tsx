'use client';

import { ChevronDown, FileText, Loader2, Receipt } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { createInvoiceAction } from '@/server/actions/invoices';

export function GenerateInvoiceButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  function generate(docType: 'invoice' | 'draw') {
    setOpen(false);
    startTransition(async () => {
      const result = await createInvoiceAction({ jobId, docType });
      if (result.ok && result.id) {
        toast.success(docType === 'draw' ? 'Draw request created.' : 'Invoice created.');
        router.push(`/invoices/${result.id}`);
      } else if (!result.ok) {
        toast.error(result.error);
      }
    });
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button disabled={isPending} size="sm">
          {isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Receipt className="size-3.5" />
          )}
          Generate
          <ChevronDown className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={() => generate('invoice')} className="gap-2">
          <Receipt className="size-3.5" />
          <div>
            <div className="text-sm font-medium">Invoice</div>
            <div className="text-xs text-muted-foreground">Bill for completed scope</div>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => generate('draw')} className="gap-2">
          <FileText className="size-3.5" />
          <div>
            <div className="text-sm font-medium">Draw request</div>
            <div className="text-xs text-muted-foreground">
              Progress payment against an open contract
            </div>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
