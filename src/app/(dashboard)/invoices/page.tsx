import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import { InvoiceEmptyState } from '@/components/features/invoices/invoice-empty-state';
import { InvoiceTable } from '@/components/features/invoices/invoice-table';
import { Button } from '@/components/ui/button';
import { listInvoices } from '@/lib/db/queries/invoices';

export default async function InvoicesPage() {
  const invoices = await listInvoices();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Invoices</h1>
          <p className="text-sm text-muted-foreground">Track payments for completed jobs.</p>
        </div>
        <Button asChild variant="outline">
          <Link href="/invoices/import">
            <Sparkles className="size-3.5" />
            Import with Henry
          </Link>
        </Button>
      </div>

      {invoices.length === 0 ? <InvoiceEmptyState /> : <InvoiceTable invoices={invoices} />}
    </div>
  );
}
