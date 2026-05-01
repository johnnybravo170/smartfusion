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
          Drop a CSV from RBC, TD, BMO, Scotia, CIBC, Amex, or anywhere else. We'll detect the
          format, preview the rows, and queue them for matching against your unpaid invoices and
          expenses.
        </p>
      </header>

      <BankImportFlow />
    </div>
  );
}
