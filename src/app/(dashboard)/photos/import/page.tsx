import { redirect } from 'next/navigation';
import { PhotoImportWizard } from '@/components/features/onboarding/photo-import-wizard';
import { DetailPageNav } from '@/components/layout/detail-page-nav';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { listProjects } from '@/lib/db/queries/projects';

export const metadata = {
  title: 'Import photos — HeyHenry',
};

// Each photo upload is one round-trip; a 50-photo drop totals ~5 min in
// worst-case latency. Bumping to 5 min gives operators headroom without
// the wizard timing out mid-drop.
export const maxDuration = 300;

export default async function PhotoImportPage() {
  const tenant = await getCurrentTenant();
  if (!tenant) redirect('/login?next=/photos/import');

  // Pull the active project list so the wizard's project picker is
  // populated server-side. Filter out completed/cancelled by default —
  // operator can search by name to surface older projects.
  const projects = await listProjects({ limit: 200 });

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <DetailPageNav homeHref="/import" homeLabel="Import" />
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Bring photos in</h1>
        <p className="text-sm text-muted-foreground">
          Pick a project, drop the photos, hit commit. Henry attaches them to the project gallery
          and the AI tagger picks them up in the background — you don&rsquo;t have to label anything
          by hand.
        </p>
      </header>
      <PhotoImportWizard
        projects={projects.map((p) => ({
          id: p.id,
          name: p.name,
          customerName: p.customer?.name ?? null,
        }))}
      />
    </div>
  );
}
