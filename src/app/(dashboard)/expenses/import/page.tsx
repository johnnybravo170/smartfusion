import { redirect } from 'next/navigation';
import { ReceiptImportWizard } from '@/components/features/onboarding/receipt-import-wizard';
import { DetailPageNav } from '@/components/layout/detail-page-nav';
import { getCurrentTenant } from '@/lib/auth/helpers';

export const metadata = {
  title: 'Import receipts — HeyHenry',
};

// Each per-file parse round-trip stays well under 60s, but the page
// surface routinely hosts 50+ files. We don't gate the wizard behind a
// long-running server action — the client fans out instead — but we
// still bump maxDuration in case the client batches a couple together.
export const maxDuration = 300;

export default async function ReceiptImportPage() {
  const tenant = await getCurrentTenant();
  if (!tenant) redirect('/login?next=/expenses/import');

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <DetailPageNav homeHref="/expenses" homeLabel="All expenses" />
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Bring your receipts in</h1>
        <p className="text-sm text-muted-foreground">
          Drop in a stack of receipt PDFs or photos. Henry reads each one, pulls out the vendor,
          amount, GST, and date, and shows you the lot to review before anything is saved. Drag in
          50 at once if you want to.
        </p>
      </header>
      <ReceiptImportWizard />
    </div>
  );
}
