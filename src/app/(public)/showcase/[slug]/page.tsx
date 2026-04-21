import { notFound } from 'next/navigation';
import { getShowcaseByTenantSlug } from '@/lib/db/queries/photos';
import { ShowcaseGallery } from './showcase-gallery';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await getShowcaseByTenantSlug(slug);
  if (!tenant) return { title: 'Showcase' };
  return {
    title: `${tenant.name} — Past projects`,
    description: `Selected work from ${tenant.name}.`,
  };
}

export default async function ShowcasePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await getShowcaseByTenantSlug(slug);
  if (!tenant) notFound();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10">
      <header className="mb-8 flex flex-col items-center gap-1 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">{tenant.name}</h1>
        <p className="text-sm text-muted-foreground">Selected work</p>
      </header>

      {tenant.photos.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-muted/20 py-20 text-center text-sm text-muted-foreground">
          No photos to show yet — check back soon.
        </div>
      ) : (
        <ShowcaseGallery photos={tenant.photos} jobTypes={tenant.job_types} />
      )}
    </div>
  );
}
