import { redirect } from 'next/navigation';
import { ProjectImportWizard } from '@/components/features/onboarding/project-import-wizard';
import { DetailPageNav } from '@/components/layout/detail-page-nav';
import { getCurrentTenant } from '@/lib/auth/helpers';

export const metadata = {
  title: 'Import projects — HeyHenry',
};

// Server actions inherit the route's maxDuration. The gateway call can
// take a minute on a multi-thousand-row paste; default 60s is too tight
// for the showcase moment.
export const maxDuration = 300;

export default async function ProjectImportPage() {
  const tenant = await getCurrentTenant();
  if (!tenant) redirect('/login?next=/projects/import');

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <DetailPageNav homeHref="/projects" homeLabel="All projects" />
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Bring your projects in</h1>
        <p className="text-sm text-muted-foreground">
          Drop in a Google Sheet, an Excel-as-CSV, or just paste rows. Henry pulls out the project
          name, who it's for, the description — and links each project to the right customer.
          Missing customers will be created alongside.
        </p>
      </header>
      <ProjectImportWizard />
    </div>
  );
}
