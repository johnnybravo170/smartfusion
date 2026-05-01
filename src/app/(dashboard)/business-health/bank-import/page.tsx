import { Info } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BankImportFlow } from '@/components/features/bank-import/bank-import-flow';
import { Button } from '@/components/ui/button';
import { getCurrentTenant } from '@/lib/auth/helpers';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Import bank statement',
};

export default async function BankImportPage() {
  const tenant = await getCurrentTenant();
  if (!tenant) redirect('/login');

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-xl font-semibold sm:text-2xl">Import bank statement</h1>
          <Button asChild variant="ghost" size="sm">
            <Link href="/business-health">← Business Health</Link>
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Save yourself from clicking "mark paid" 50 times a month. Drop your monthly statement and
          we'll find every invoice and expense already in HeyHenry that matches a transaction —
          confirm in one click.
        </p>
      </header>

      <aside className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
        <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
          <Info className="size-3.5" />
          What this is (and isn't)
        </div>
        <ul className="ml-4 list-disc space-y-1">
          <li>
            <strong>Is:</strong> a payment shortcut. We match bank lines to unpaid invoices,
            expenses, and bills you've already entered, and let you mark them paid in bulk.
          </li>
          <li>
            <strong>Isn't:</strong> bank reconciliation. Your bookkeeper still does that in
            QuickBooks against QBO's bank feed — we don't try to replace it.
          </li>
          <li>
            Transfers, fees, interest, ATM withdrawals — anything that isn't an invoice or expense —
            get left alone here. Those belong in QBO.
          </li>
        </ul>
      </aside>

      <BankImportFlow />
    </div>
  );
}
