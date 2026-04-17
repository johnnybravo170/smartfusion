import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { CatalogManager } from '@/components/features/settings/catalog-manager';
import { listCatalogEntries } from '@/lib/db/queries/service-catalog';

export const metadata = {
  title: 'Service Catalog — HeyHenry',
};

export default async function CatalogSettingsPage() {
  const entries = await listCatalogEntries(false); // include inactive

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to settings
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Service Catalog</h1>
        <p className="text-sm text-muted-foreground">
          Configure the surface types and pricing used in your quotes.
        </p>
      </header>

      <CatalogManager entries={entries} />
    </div>
  );
}
