import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BankReviewQueue } from '@/components/features/bank-review/bank-review-queue';
import { Button } from '@/components/ui/button';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { listBankReviewQueue, listImportedStatements } from '@/lib/db/queries/bank-review-queue';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Review bank matches',
};

export default async function BankReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ statement?: string; include_unmatched?: string }>;
}) {
  const tenant = await getCurrentTenant();
  if (!tenant) redirect('/login');

  const params = await searchParams;
  const filters = {
    statement_id: params.statement,
    include_unmatched: params.include_unmatched === '1',
  };

  const [{ rows, counts }, statements] = await Promise.all([
    listBankReviewQueue(filters),
    listImportedStatements(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-xl font-semibold sm:text-2xl">Review bank matches</h1>
          <div className="flex gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/business-health">← Business Health</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/business-health/bank-import">Import another statement</Link>
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Confirm the matches we found between your bank statement and your unpaid invoices,
          expenses, and bills. High-confidence matches are pre-checked — confirm in bulk.
        </p>
      </header>

      <BankReviewQueue
        initialRows={rows}
        counts={counts}
        statements={statements}
        filters={filters}
      />
    </div>
  );
}
