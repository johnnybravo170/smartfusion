import { redirect } from 'next/navigation';
import { InvoiceImportWizard } from '@/components/features/onboarding/invoice-import-wizard';
import { DetailPageNav } from '@/components/layout/detail-page-nav';
import { getCurrentTenant } from '@/lib/auth/helpers';

export const metadata = {
  title: 'Import invoices — HeyHenry',
};

// Gateway round-trip on a multi-thousand-row paste can run a couple
// minutes; default 60s is too tight. Server actions inherit this.
export const maxDuration = 300;

export default async function InvoiceImportPage() {
  const tenant = await getCurrentTenant();
  if (!tenant) redirect('/login?next=/invoices/import');

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <DetailPageNav homeHref="/invoices" homeLabel="All invoices" />
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Bring your invoices in</h1>
        <p className="text-sm text-muted-foreground">
          Drop in a QuickBooks export, a Jobber CSV, or paste rows. Henry pulls out the customer,
          the project (if any), the amount + tax, and the status. Historical tax math stays frozen —
          your 2024 BC invoices keep their original 5% even if rules change later.
        </p>
      </header>
      <InvoiceImportWizard />
    </div>
  );
}
