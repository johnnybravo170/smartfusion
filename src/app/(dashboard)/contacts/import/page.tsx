import { redirect } from 'next/navigation';
import { CustomerImportWizard } from '@/components/features/onboarding/customer-import-wizard';
import { DetailPageNav } from '@/components/layout/detail-page-nav';
import { getCurrentTenant } from '@/lib/auth/helpers';

export const metadata = {
  title: 'Import customers — HeyHenry',
};

export default async function CustomerImportPage() {
  // Same gate as the rest of /contacts — require an active tenant.
  const tenant = await getCurrentTenant();
  if (!tenant) redirect('/login?next=/contacts/import');

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <DetailPageNav homeHref="/contacts" homeLabel="All contacts" />
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Bring your customers in</h1>
        <p className="text-sm text-muted-foreground">
          Drop in an export from QuickBooks, Jobber, Houzz Pro, an Excel sheet, or just paste the
          list. Henry will sort it out — and flag anyone you already have on file.
        </p>
      </header>
      <CustomerImportWizard />
    </div>
  );
}
