import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { CostCatalogManager } from '@/components/features/settings/cost-catalog-manager';
import { listLabourRates } from '@/lib/db/queries/labour-rates';
import { listMaterialsCatalog } from '@/lib/db/queries/materials-catalog';

export const metadata = { title: 'Cost Catalog — HeyHenry' };

export default async function CostCatalogPage() {
  const [materials, labourRates] = await Promise.all([
    listMaterialsCatalog(true),
    listLabourRates(true),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to settings
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Cost Catalog</h1>
        <p className="text-sm text-muted-foreground">
          Materials, labour rates, and markup rules for GC projects. Pull items directly into
          project estimates.
        </p>
      </header>

      <CostCatalogManager materials={materials} labourRates={labourRates} />
    </div>
  );
}
