import { redirect } from 'next/navigation';
import { TimeEntryImportWizard } from '@/components/features/onboarding/time-entry-import-wizard';
import { DetailPageNav } from '@/components/layout/detail-page-nav';
import { getCurrentTenant } from '@/lib/auth/helpers';

export const metadata = {
  title: 'Import time entries — HeyHenry',
};

export const maxDuration = 300;

export default async function TimeEntryImportPage() {
  const tenant = await getCurrentTenant();
  if (!tenant) redirect('/login?next=/time/import');

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <DetailPageNav homeHref="/import" homeLabel="Import" />
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Bring time entries in</h1>
        <p className="text-sm text-muted-foreground">
          Drop a payroll sheet or paste rows. Henry pulls out the worker, the project, the date, and
          the hours — and matches each row to a real member of your team. Anything that
          doesn&rsquo;t match falls back to you, and you can re-assign per-row before commit.
        </p>
      </header>
      <TimeEntryImportWizard />
    </div>
  );
}
